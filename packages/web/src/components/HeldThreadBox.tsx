import { useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { useMutation } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { showToast } from "../store.ts"
import { useThreadApi, useThreadApiBase } from "../api/threadApi.tsx"
import { PluginBoundary, pluginCaller, usePluginSlots } from "../plugins/loader.tsx"
import type { HeldThreadBoxProps } from "../plugins/api.ts"
import { Composer } from "./Composer.tsx"

// A HELD THREAD's prompt box (ThreadView.held): a thread written down with no agent behind it. Its text IS
// the box's text — there is no separate note view to keep in step with a draft — so the queue card and the
// drawer show the same words, edits save back as they are typed, and sending it starts the agent with
// whatever the box says by then.
//
// It is not ThreadComposerBox, on purpose. Everything that box carries is about a RUNNING agent — its model
// and permission controls act on a live runtime, `/` asks the harness for its skills, ⌘-Enter interrupts a
// turn, `$ cmd` opens a terminal in the agent's folder — and a held thread has none of those yet. The
// profile it starts on is the one the prompt box had when it was written down.
//
// The draft store is not used either: the holder keeps the text, so the box reads it from the board and
// writes it back. `saved` is the last text this box knows the holder has, which is how a board push of our
// own save is told apart from an edit made somewhere else (the other surface, another tab).
//
// WHO DRAWS IT (HeldThreadComposer below): the HOLDER's `thread.composer` slot when its Frizz plugin is
// loaded — the lazy plugin binds this same box to its own note (plugins/lazy/web.ts, through host.ui) — and
// base's binding otherwise: a schedule's next run (base holds it), or a thread whose plugin is gone, whose
// box starts it on what base kept (ThreadView.heldPrompt). Lazy threads drew this as LazyThreadBox until
// 2026-10-06, when they moved into the `lazy` plugin.
const SAVE_DELAY_MS = 500

export function HeldThreadBox({ thread, surface, className, id, note, save, start, placeholder, footer }: HeldThreadBoxProps): ReactElement {
  const [text, setText] = useState(note)
  const saved = useRef(note)

  // Another surface saved a different text: take it, unless this box has unsaved typing of its own.
  useEffect(() => {
    if (note === saved.current) return
    setText((current) => (current === saved.current ? note : current))
    saved.current = note
  }, [note])

  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (text === saved.current || !saveRef.current) return
    const timer = setTimeout(() => {
      const sending = text
      saveRef.current?.(sending).then(
        () => { saved.current = sending },
        // Started meanwhile (another tab sent it): the text is now the thread's first message, so there is
        // nothing left to save it into.
        () => {},
      )
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, thread.id])

  const launch = useMutation({
    mutationFn: (prompt: string) => start(prompt),
    onError: (cause) => showToast(`Could not start the agent: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 80)}`),
  })

  const submit = () => {
    const prompt = text.trim()
    if (!prompt || !thread.sessionId || launch.isPending) return
    launch.mutate(prompt)
  }

  return (
    <div data-thread-composer-box={surface} data-held-box={thread.held ?? ""} className={className}>
      <Composer
        id={id}
        surface={surface}
        value={text}
        onChange={setText}
        onSubmit={submit}
        placeholder={placeholder ?? "Describe the task…"}
        busy={launch.isPending}
        footer={<span className="pl-1 text-[11px] text-muted-70">{footer ?? "Send to start an agent"}</span>}
      />
    </div>
  )
}

type HeldComposerProps = { thread: ThreadView; surface: "queueComposer" | "chatComposer"; className?: string; id?: string }

/** Base's binding: the text base keeps (ThreadView.heldPrompt), saved and started through base's own verbs. */
function BaseHeldThreadBox({ thread, surface, className, id }: HeldComposerProps): ReactElement {
  const api = useThreadApi()
  const sessionId = thread.sessionId ?? ""
  return (
    <HeldThreadBox
      thread={thread}
      surface={surface}
      className={className}
      id={id}
      note={thread.heldPrompt ?? ""}
      save={(prompt) => api.updateHeldPrompt({ slug: thread.id, sessionId, prompt })}
      start={(prompt) => api.startHeldThread({ slug: thread.id, sessionId, prompt })}
    />
  )
}

/**
 * The prompt box of a held thread: its holder's `thread.composer` slot, fenced, or base's box. A slot that
 * throws falls back to base's box — which still starts the thread — and is listed in Settings → Frizz plugins.
 */
export function HeldThreadComposer(props: HeldComposerProps): ReactElement {
  const slots = usePluginSlots("thread.composer")
  const base = useThreadApiBase()
  const holder = slots.find(({ plugin }) => plugin.id === props.thread.held)
  const summary = holder?.plugin.summary
  const call = useMemo(() => (summary ? pluginCaller(summary, () => base) : undefined), [summary, base])
  if (!holder || !call) return <BaseHeldThreadBox {...props} />
  const Slot = holder.slot
  return (
    <PluginBoundary id={holder.plugin.id} slot="thread.composer" fallback={<BaseHeldThreadBox {...props} />}>
      <Slot {...props} call={call} />
    </PluginBoundary>
  )
}
