import { useEffect, useRef, useState, type ReactElement } from "react"
import { useMutation } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { showToast } from "../store.ts"
import { useThreadApi } from "../api/threadApi.tsx"
import { Composer } from "./Composer.tsx"

// A LAZY THREAD's prompt box (plans/lazy-threads.md): a thread written down without an agent. The note IS the box's
// text — there is no separate note view to keep in step with a draft — so the queue card and the drawer
// show the same words, edits save back to the thread as they are typed, and sending it starts the agent
// with whatever the box says by then.
//
// It is not ThreadComposerBox, on purpose. Everything that box carries is about a RUNNING agent — its
// model and permission controls act on a live runtime, `/` asks the harness for its skills, ⌘-Enter
// interrupts a turn, `$ cmd` opens a terminal in the agent's folder — and a lazy thread has none of those yet.
// The profile it starts on is the one the prompt box had when it was written down.
//
// The draft store is not used either: the server holds the note, so the box reads it from the board and
// writes it back. `saved` is the last text this box knows the server has, which is how a board push of
// our own save is told apart from an edit made somewhere else (the other surface, another tab).
const SAVE_DELAY_MS = 500

export function LazyThreadBox({
  thread,
  surface,
  className,
  id,
}: {
  thread: ThreadView
  surface: "queueComposer" | "chatComposer"
  className?: string
  id?: string
}): ReactElement {
  const api = useThreadApi()
  const note = thread.lazyPrompt ?? ""
  const [text, setText] = useState(note)
  const saved = useRef(note)

  // Another surface saved a different note: take it, unless this box has unsaved typing of its own.
  useEffect(() => {
    if (note === saved.current) return
    setText((current) => (current === saved.current ? note : current))
    saved.current = note
  }, [note])

  useEffect(() => {
    if (text === saved.current || !thread.sessionId) return
    const timer = setTimeout(() => {
      const sending = text
      api.updateLazyPrompt({ slug: thread.id, sessionId: thread.sessionId!, prompt: sending }).then(
        () => { saved.current = sending },
        // Started meanwhile (another tab sent it): the note is now the thread's first message, so there is
        // nothing left to save it into.
        () => {},
      )
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, thread.id, thread.sessionId, api])

  const launch = useMutation({
    mutationFn: (prompt: string) => api.startLazyThread({ slug: thread.id, sessionId: thread.sessionId!, prompt }),
    onError: (cause) => showToast(`Could not start the agent: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 80)}`),
  })

  const submit = () => {
    const prompt = text.trim()
    if (!prompt || !thread.sessionId || launch.isPending) return
    launch.mutate(prompt)
  }

  return (
    <div data-thread-composer-box={surface} data-lazy-box className={className}>
      <Composer
        id={id}
        surface={surface}
        value={text}
        onChange={setText}
        onSubmit={submit}
        placeholder="Describe the task…"
        busy={launch.isPending}
        footer={<span className="pl-1 text-[11px] text-muted-70">Send to start an agent</span>}
      />
    </div>
  )
}
