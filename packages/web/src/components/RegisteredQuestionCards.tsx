// The surface a REGISTERED question renders on — a question a worker created with the `ask` tool, which
// is a row in `thread_question` rather than a fence in a message. That is the whole difference, and it
// is the reason this file exists at all: a fenced question lives and dies with the message carrying it,
// so it vanishes from view the moment the transcript scrolls or the context is compacted, while a
// registration is still owed an answer tomorrow. So these cards do NOT ride the transcript on their own:
// they render at the bottom of the rest they belong to (lib/questionShadow questionStacks), after every
// word of its handoff and never inside a message (maintainer 2026-09-28: "questions should always appear
// at the bottom of the thread not in the middle any explanation should occur beforehand").
//
// The CARD is the shared one (QuestionBlockCard); only the plumbing is new. What a registration adds
// over the other two producers is the STATIC TREE: an option may carry follow-ups that become live only
// once that option is picked, so one registration renders as a stack of cards that grows as it is
// answered. lib/registeredQuestion.ts performs that walk; nothing here decides which nodes are live.
//
// ONE ANSWERING STATE PER THREAD, however many mounts. The `answerQuestions` RPC takes every staged
// answer in ONE call (a per-question send would half-wake the worker), and one thread can have stacks at
// more than one depth — a question the human replied past up at its own rest, a newer one at the tail —
// so the staged picks cannot live in the stack that draws them. `useRegisteredAnswering` holds them for
// the whole thread; the surface mounts it ONCE (RegisteredAnsweringProvider) and every stack on that
// surface reads it through context, so either stack's Send sends both. A stack mounted with no provider
// above it (a surface that draws one stack) owns a state of its own.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import type { QuestionAnswer, RegisteredQuestionView, SettledQuestionView, ThreadView } from "@frizz/shared"
import { rpc, type Api } from "../api/rpc.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir } from "../lib/drafts.ts"
import { clearSteered, clearSteeredIn, markSteered, markSteeredIn } from "../lib/steering.ts"
import type { BlockAnswer } from "../lib/questionBlocks.ts"
import type { PairedAnswer } from "../lib/answersMessage.ts"
import { ROOT_PATH, liveQuestionNodes, nodeAnswered, registeredAnswer, settledQuestionNodes } from "../lib/registeredQuestion.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { QueueDismissContext } from "./ChatView.tsx"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The answer could not be sent."
  return message.length > 240 ? `${message.slice(0, 239)}…` : message
}

/** The chip/toggle half of a staged answer, keyed by `<question id>|<node path>`. The free-text half
 *  lives in the draft store instead, so a half-typed answer survives a remount and a worker restart. */
type Picks = Map<string, { chosen: number | null; chosenSet: number[] }>
const pickKey = (id: string, path: string) => `${id}|${path}`

/** The thread's whole answering state: what is staged on every open question, and the one send. */
export interface RegisteredAnswering {
  slug: string | undefined
  answerFor: (q: RegisteredQuestionView, path: string) => BlockAnswer
  answersOf: (q: RegisteredQuestionView) => ReadonlyMap<string, BlockAnswer>
  onChip: (q: RegisteredQuestionView, path: string, isMulti: boolean, optIdx: number) => void
  onText: (q: RegisteredQuestionView, path: string, isMulti: boolean, text: string) => void
  dismiss: (id: string) => void
  dismissing: boolean
  /** Send EVERY staged answer on the thread — this rest's or an older one's. */
  submit: () => void
  staged: number
  sending: boolean
  error: string | undefined
}

export const RegisteredAnsweringContext = createContext<RegisteredAnswering | null>(null)

/**
 * Which project a surface's answers go to, for a surface showing a project OTHER than the page's own.
 *
 * Absent — every board and drawer — the answers go where the page's `rpc` goes and the drafts key on the
 * page's board. The All queues page shows every project on a page that names none, where both of those
 * mean the LAUNCHING project: it passes the thread's own project-bound client and directory, so an
 * answer lands on the thread that asked and a half-typed one shares its draft with that project's board.
 */
export interface RegisteredAnsweringScope {
  api: Pick<Api, "answerQuestions" | "dismissQuestions">
  projectDir: string | undefined
  /** Whose steer an answer is: the project list reads it back for that project's row (lib/steering.ts). */
  projectId: string
}

/** The state behind every registered card on a surface. `thread` undefined (a stack that found a
 *  provider above it) yields an inert state nobody reads — hooks cannot be conditional. */
export function useRegisteredAnswering(thread: ThreadView | undefined, scope?: RegisteredAnsweringScope): RegisteredAnswering {
  const slug = thread?.id
  const questions = thread?.questions ?? []
  const pageProjectDir = useProjectDir()
  const projectDir = scope ? scope.projectDir : pageProjectDir
  const api = scope?.api ?? rpc
  const [picks, setPicks] = useState<Picks>(() => new Map())
  const [error, setError] = useState<string>()
  // THE QUEUE CARD DISSOLVES ON SEND, like every other action on it. Answering is the same commitment as
  // a fenced Send answers or a composer steer — both of which take the card out of the queue the instant
  // the human commits, without waiting on the round-trip (see useLiveAnswering's onSent) — and this was
  // the one send that did not, so a card answered on a loaded machine sat there for the seconds it took
  // the board to catch up, which is the window its answer rendered twice in (2026-09-01). Null on the
  // thread page, where there is no card to dismiss.
  const queueDismiss = useContext(QueueDismissContext)

  // Every free-text box of every question, subscribed as one batch — the draft store's own hook takes a
  // key list, and the set only changes when a question is registered or settled.
  const textKeys = useMemo(
    () => (slug ? questions.flatMap((q) => allPaths(q).map((path) => draftKey.question(projectDir, slug, q.id, path))) : []),
    [projectDir, slug, questions],
  )
  const persistedText = useDraftValues(textKeys)
  const answerFor = (q: RegisteredQuestionView, path: string): BlockAnswer => {
    const pick = picks.get(pickKey(q.id, path))
    return {
      chosen: pick?.chosen ?? null,
      chosenSet: pick?.chosenSet ?? [],
      text: (slug ? persistedText.get(draftKey.question(projectDir, slug, q.id, path)) : undefined) ?? "",
    }
  }
  const answersOf = (q: RegisteredQuestionView): ReadonlyMap<string, BlockAnswer> =>
    new Map(allPaths(q).map((path) => [path, answerFor(q, path)]))

  // EVERY answered question goes in ONE call. A per-question send would half-wake the turn: the worker
  // would come back to a payload it cannot act on and would have to ask for the rest again.
  const stagedPairs = questions.flatMap((q) => {
    const built = registeredAnswer(q, answersOf(q))
    return built ? [{ q, answer: built }] : []
  })
  const staged: QuestionAnswer[] = stagedPairs.map((pair) => pair.answer)
  const queryClient = useQueryClient()

  const send = useMutation({
    mutationFn: async (answers: QuestionAnswer[]) => api.answerQuestions({ slug: slug!, answers }),
    onSuccess: (result) => {
      // The rows are gone from the board push that follows, so the staged state for them is dead weight;
      // dropping the drafts too keeps a re-asked question from opening pre-filled with a stale answer.
      for (const id of result.answered) {
        setPicks((prev) => {
          const next = new Map(prev)
          for (const key of [...next.keys()]) if (key.startsWith(`${id}|`)) next.delete(key)
          return next
        })
        const q = questions.find((entry) => entry.id === id)
        if (q && slug) for (const path of allPaths(q)) draftStore.set(draftKey.question(projectDir, slug, q.id, path), "")
      }
    },
    onError: (cause) => {
      // The card faded on click; the answer did not land, so put it back rather than leaving the human
      // looking at a queue that quietly swallowed their reply. Same reversal an optimistic Mark-as-done
      // makes when the server declines it.
      queueDismiss?.cancel()
      if (slug && scope) clearSteeredIn(scope.projectId, slug)
      else if (slug) clearSteered(slug)
      setError(errorText(cause))
    },
    // Server truth replaces the optimistic settled cards either way: on success it carries the real
    // `settledAt`, and on failure it no longer holds them, which brings the open card back.
    onSettled: () => {
      if (slug) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug) })
    },
  })
  const dismiss = useMutation({
    mutationFn: async (id: string) => api.dismissQuestions({ slug: slug!, ids: [id] }),
    onError: (cause) => setError(errorText(cause)),
  })

  const submit = () => {
    if (!slug || staged.length === 0 || send.isPending) return
    setError(undefined)
    // Local truth FIRST, then the network — the ordering every other send on this card obeys, and the
    // whole of what "the card goes away when I answer it" means on a machine under load.
    queueDismiss?.dismiss()
    // …AND THE RAIL ROW GOES TO WORK WITH IT. Every answer wakes the worker (the scheduler delivers the
    // batch), so this is a steer in all but name, and it takes the steer's overlay: without it the row
    // dropped its question mark on the board push, sat in the queue wearing the at-rest ellipsis, and only
    // moved to the running band once the delivery landed (lib/steering.ts).
    // On another project's card the record is that project's (markSteeredIn): a bare slug there would
    // set the page project's thread of the same name to work.
    if (scope) markSteeredIn(scope.projectId, slug)
    else markSteered(slug)
    // THE CARD GREYS IN PLACE ON SEND, before the round-trip: the answered question joins the settled
    // list now, and the surface stops drawing the open card for any id that list holds (see
    // withoutSettledQuestions). Waiting for the server instead left a beat where the open card had gone
    // with the board push and the settled one had not arrived — the card blinking out and back.
    const key = settledQuestionsKey(slug)
    void queryClient.cancelQueries({ queryKey: key })
    const settledAt = new Date().toISOString()
    const ids = new Set(stagedPairs.map((pair) => pair.q.id))
    queryClient.setQueryData<SettledQuestion[]>(key, (prev) => [
      ...(prev ?? []).filter((s) => !ids.has(s.id)),
      ...stagedPairs.map(({ q, answer }): SettledQuestion => ({ id: q.id, spec: q.spec, askedAt: q.askedAt, settledAt, answer, pending: true })),
    ])
    send.mutate(staged)
  }

  return {
    slug,
    answerFor,
    answersOf,
    onChip: (q, path, isMulti, optIdx) => {
      // SINGLE: picking a chip makes it the answer; re-picking toggles off — mirroring both other
      // producers. The typed draft is never cleared (maintainer 2026-09-02): it stays in the box as an
      // unselected draft, and registeredAnswer submits the chip while one is chosen (the box taking
      // focus clears it via onText below).
      setPicks((prev) => {
        const next = new Map(prev)
        const key = pickKey(q.id, path)
        const pick = next.get(key) ?? { chosen: null, chosenSet: [] }
        if (isMulti) {
          const set = pick.chosenSet.includes(optIdx)
            ? pick.chosenSet.filter((v) => v !== optIdx)
            : [...pick.chosenSet, optIdx]
          next.set(key, { ...pick, chosenSet: set })
        } else {
          next.set(key, { ...pick, chosen: pick.chosen === optIdx ? null : optIdx })
        }
        return next
      })
    },
    onText: (q, path, isMulti, text) => {
      if (!slug) return
      draftStore.set(draftKey.question(projectDir, slug, q.id, path), text)
      // SINGLE: the free-text box taking over — a keystroke OR just focusing it — drops the chosen chip,
      // as the fence producer does. The card's onFocus calls this with the text unchanged for exactly
      // that reason, so writing the draft alone left the chip lit beside a focused box (2026-08-28).
      if (!isMulti) setPicks((prev) => {
        const key = pickKey(q.id, path)
        const pick = prev.get(key)
        if (!pick || pick.chosen === null) return prev
        return new Map(prev).set(key, { ...pick, chosen: null })
      })
    },
    dismiss: (id) => dismiss.mutate(id),
    dismissing: dismiss.isPending,
    submit,
    staged: staged.length,
    sending: send.isPending,
    error,
  }
}

// ---- ANSWERED questions: the card stays where it stood, greyed, showing only the answer ----

/** An answered registration as the transcript draws it. `pending` marks one this tab just sent and has
 *  not yet read back — see lib/settledQuestions. */
export type SettledQuestion = SettledQuestionView & { pending?: true }
const NO_SETTLED: readonly SettledQuestion[] = []
export const settledQuestionsKey = (slug: string) => ["settledQuestions", slug] as const

/** The thread's answered questions. Read per thread rather than off the board (see the shared
 *  SettledQuestionView), and re-read on the one board event that can add to it: a question leaving the
 *  OPEN list — answered here, in another tab, or on the queue card. A withdrawal or a dismissal re-reads
 *  too, and finds nothing new; that costs one indexed SELECT. */
export function useSettledQuestions(thread: ThreadView | undefined): readonly SettledQuestion[] {
  const slug = thread?.id
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: settledQuestionsKey(slug ?? ""),
    queryFn: async (): Promise<SettledQuestion[]> => (await rpc.threadSettledQuestions({ slug: slug! })).questions,
    enabled: Boolean(slug),
    refetchOnWindowFocus: false,
  })
  const openIds = (thread?.questions ?? []).map((q) => q.id).join(" ")
  const previous = useRef(openIds)
  useEffect(() => {
    const before = previous.current
    previous.current = openIds
    if (!slug || before === openIds) return
    const now = new Set(openIds.split(" "))
    if (before.split(" ").some((id) => id && !now.has(id))) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug) })
  }, [openIds, queryClient, slug])
  return query.data ?? NO_SETTLED
}

const NO_OPEN: readonly RegisteredQuestionView[] = []

/** The thread's OPEN questions minus every one the settled list already holds, so one question never
 *  draws twice: in the beat between Send and the board push the row is still open on the board while
 *  its settled card is already drawn. For the question cards ONLY — everything else keeps reading the
 *  board's own `thread.questions`, because the rows are still open there until that push, and the push
 *  is what also brings `answersInFlight`: a surface that saw no questions AND nothing in flight in that
 *  beat would draw the "Rested without a sign-off" card in the hole. The board's own array when nothing
 *  is taken, so a memo keyed on it does not churn. */
export function openQuestionsOf(thread: ThreadView | undefined, settled: readonly SettledQuestion[]): readonly RegisteredQuestionView[] {
  const open = thread?.questions ?? NO_OPEN
  if (settled.length === 0 || open.length === 0) return open
  const ids = new Set(settled.map((s) => s.id))
  return open.some((q) => ids.has(q.id)) ? open.filter((q) => !ids.has(q.id)) : open
}

/** ONE answered registration, in the slot its open card filled: the same card, the same branch rule,
 *  greyed, and carrying only what was picked or typed. Read-only — the answer has been sent. */
export function SettledQuestionCard({ s, wrap }: { s: SettledQuestion; wrap?: boolean }) {
  const nodes = useMemo(() => settledQuestionNodes(s.spec, s.answer), [s.spec, s.answer])
  const card = (node: (typeof nodes)[number]) => (
    <QuestionBlockCard
      key={node.path}
      question={node.question}
      // "Question" even for a `multi`: its own title, "Select multiple", is an instruction nobody can act
      // on any more.
      label={node.depth > 1 ? "Follow-up" : "Question"}
      settled={node.settled}
      wrap={wrap}
    />
  )
  const branch = nodes.slice(1)
  return (
    <article data-question-id={s.id} data-settled-question aria-label="Answered question" className="flex min-w-0 flex-col gap-2 opacity-60">
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className="ml-3 flex flex-col gap-2 border-l border-border pl-3">
          {branch.map((node) => (
            <div key={node.path} className={node.depth > 2 ? "ml-3 border-l border-border pl-3" : undefined}>
              {card(node)}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

/** Several answered registrations anchored after one message. */
export function SettledQuestionStack({ questions, wrap, className = "" }: { questions: readonly SettledQuestion[]; wrap?: boolean; className?: string }) {
  if (questions.length === 0) return null
  return (
    <section data-settled-questions aria-label={`${questions.length} answered question${questions.length === 1 ? "" : "s"}`} className={`flex min-w-0 flex-col gap-3 ${className}`}>
      {questions.map((s) => <SettledQuestionCard key={s.id} s={s} wrap={wrap} />)}
    </section>
  )
}

/** Mount ONCE per surface that draws registered cards in more than one place. Must sit INSIDE the
 *  surface's QueueDismissContext, which the send reads. */
export function RegisteredAnsweringProvider({ thread, scope, children }: { thread: ThreadView | undefined; scope?: RegisteredAnsweringScope; children: ReactNode }) {
  const answering = useRegisteredAnswering(thread, scope)
  return <RegisteredAnsweringContext.Provider value={answering}>{children}</RegisteredAnsweringContext.Provider>
}

/** ONE registered question: its root card and the follow-up branch the staged answer opens. Reads the
 *  surface's shared state through context, or the one a stack hands it. */
export function RegisteredQuestionCard({ q, answering: given }: { q: RegisteredQuestionView; answering?: RegisteredAnswering }) {
  const shared = useContext(RegisteredAnsweringContext)
  const a = given ?? shared
  if (!a || !a.slug) return null
  const nodes = liveQuestionNodes(q.spec, a.answersOf(q))
  const card = (node: (typeof nodes)[number]) => (
    <QuestionBlockCard
      key={node.path}
      question={node.question}
      // Named for what it IS, so the relationship survives even where the rule is subtle.
      label={node.depth > 1 ? "Follow-up" : undefined}
      // The ×, on the ROOT card's title row only — one registration is one thing to dismiss, and a
      // follow-up cannot be declined separately from the answer that opened it. It is NEVER offered on
      // a `danger` question: a generic close icon is not consent for something irreversible, and
      // declining is a real option INSIDE that question. The server refuses one too, so this is the
      // affordance and not the rule.
      aside={node.depth === 1 && !q.spec.danger ? (
        <button
          type="button"
          data-dismiss-question
          aria-label="Dismiss this question"
          title="Dismiss — the worker decides it itself"
          disabled={a.dismissing}
          onClick={() => a.dismiss(q.id)}
          // PLACED BY CONSTRUCTION, not by a fitted constant. `p-1 -m-1` cancels exactly, so the
          // button's layout box is the bare 16px svg while its hit area stays 24px; at 16px lucide's X
          // paints 8px of ink centred in its box, and `card-icon-offset` centres that ink on the
          // title's cap block, with nothing to re-measure when the type scale moves.
          // Hand-placed at `-my-1` with a 13px glyph first: the x rode 2.40px above where the offset
          // now puts it. (It shared the corner with the card's HelpCircle kind glyph until 2026-08-31,
          // when the glyph was dropped — a full-strength decoration beside the muted control read as
          // the actionable thing — so the × is the corner mark now.)
          //
          // `flex` is load-bearing: a button is inline-block by default, so inside the head's
          // `leading-6` aside span it sits on that span's BASELINE — which moves with the font and put
          // the x 1.00px high under sans while reading 0.00 under mono. A block-level box has no
          // baseline to sit on, and both settings then measure 0.00.
          //
          // HORIZONTALLY the trim is DEEPER than the padding, because lucide's X paints only 8 of its
          // 16 box px: `-mx-2` collapses the padding AND that inset, so the layout box IS the ink box
          // — which now lands the ×'s ink flush on the card's right content edge (the p-4 inset),
          // where the dropped glyph's ink sat 1.33px shy of it.
          className="icon-hover-outline card-icon-offset -mx-2 -my-1 flex rounded-md p-1 text-muted-70 outline-none transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40"
        >
          <X size={16} />
        </button>
      ) : undefined}
      interactive={{
        answer: a.answerFor(q, node.path),
        onChip: (optIdx) => a.onChip(q, node.path, node.spec.kind === "multi", optIdx),
        onText: (text) => a.onText(q, node.path, node.spec.kind === "multi", text),
        onSubmit: a.submit,
      }}
    />
  )
  // THE WHOLE BRANCH SITS BEHIND ONE CONTINUOUS RULE, opened by the first follow-up and closed by the
  // last — everything below the root belongs to the single option that was taken. A rule per card (the
  // first cut) drew that one branch as a stack of unrelated indents, because the article's own gap broke
  // the line between every pair. Depth 3 nests its own rule inside this one, which is where the tree
  // stops (ASK_MAX_DEPTH).
  const branch = nodes.slice(1)
  return (
    <article data-question-id={q.id} className="flex min-w-0 flex-col gap-2">
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className="ml-3 flex flex-col gap-2 border-l border-border pl-3">
          {branch.map((node) => (
            <div key={node.path} className={node.depth > 2 ? "ml-3 border-l border-border pl-3" : undefined}>
              {card(node)}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

export function RegisteredQuestionStack({
  thread,
  questions: only,
  inFlight = null,
  className = "",
}: {
  thread: ThreadView | undefined
  // WHICH of the thread's open questions this mount draws. Every surface hangs a question after the REST
  // IT BELONGS TO rather than at the transcript's tail (lib/questionShadow questionStacks), so one thread
  // can have several of these mounted at different depths — each handed its own group.
  questions?: readonly RegisteredQuestionView[]
  // THE ANSWER ALREADY SENT AND NOT YET ON SCREEN ANYWHERE ELSE — the rows of `thread.answersInFlight`
  // the transcript is not already drawing (lib/answersMessage.unrenderedAnswers). Passed IN rather than
  // read off the thread here, because deciding it needs the transcript this stack is pinned beside, and
  // because only ONE mount may draw it: the answer is the human's newest turn and belongs at the tail
  // however deep the questions themselves sit. An anchored mount simply omits it.
  inFlight?: PairedAnswer[] | null
  className?: string
}) {
  const slug = thread?.id
  const questions = only ?? thread?.questions ?? []
  // A provider above this stack owns the state; without one, this stack does (a surface that draws only
  // one stack has no reason to mount the provider).
  const shared = useContext(RegisteredAnsweringContext)
  const own = useRegisteredAnswering(shared ? undefined : thread)
  const a = shared ?? own

  // THE ANSWER, ALREADY SENT AND NOT YET IN THE WORKER'S HANDS. Answering stores the row; a wake hands
  // it over a moment later (deliberately — an answer given while the worker's process is down has to
  // survive the gap). In between, the question card is gone and the delivered turn has not arrived, so
  // this slot went EMPTY and the thread — at rest, with nothing registered any more — drew the residual
  // "Rested without a sign-off" card in the hole (maintainer 2026-08-27: "a little card that, for like
  // 5+ seconds, just says that the thread rested without a sign-off before it shows up my answer").
  //
  // The board composes the bytes the delivery will carry, and the caller parses them with the reader the
  // chat uses on the landed turn — so the in-flight card and the real one are the SAME card and the swap
  // is invisible. Dimmed while it is in flight, exactly like an optimistic follow-up bubble. The caller
  // also decides when it has become a SECOND copy of a card the transcript is already drawing, which is
  // the whole reason the rows arrive as a prop rather than off the thread — see unrenderedAnswers.
  if (!slug || questions.length === 0) {
    if (!slug || !inFlight?.length) return null
    return (
      <section data-answers-in-flight aria-label="Your answer, on its way to the worker" className={`flex min-w-0 flex-col items-end ${className}`}>
        <AnswersCard answers={inFlight} queued />
      </section>
    )
  }

  return (
    <section
      data-registered-questions
      aria-label={`${questions.length} question${questions.length === 1 ? "" : "s"} waiting for an answer`}
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      {questions.map((q) => <RegisteredQuestionCard key={q.id} q={q} answering={a} />)}
      {a.error && <div role="alert" className="break-words text-[11px] leading-snug text-danger-soft">{a.error}</div>}
      {a.sending && (
        <div role="status" aria-live="polite" className="text-[11px] leading-snug text-muted">Sending…</div>
      )}
      {/* HUNG OFF THE QUESTIONS IT SENDS, not spaced like one more of them: 8px under the last card
          against the stack's 12px rhythm. On the queue card the reply box sits 17px below, and the
          stack's plain 12px there read as a button floating between the two, half an appendage of
          the box (the rule scripts/verify-open-ask-composer.mjs holds, from the maintainer's
          2026-07-22 "the spacing is insane": ≤10px up, at least 1.5x that down). Both marks here are
          filled or bordered boxes, so the box gap IS the ink gap. */}
      <div className="-mt-1 flex justify-start">
        <button
          type="button"
          data-send-answers
          disabled={a.staged === 0 || a.sending}
          onClick={a.submit}
          onMouseDown={(e) => e.preventDefault()}
          className="button-outline rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
        >
          Send answers
        </button>
      </div>
    </section>
  )
}

/** EVERY node path in a question's tree — live or not. The draft subscription and the clear-on-send both
 *  need the whole tree, not just what is currently on screen: text typed into a branch, abandoned, and
 *  returned to must still be there, and a settled question must leave nothing behind anywhere. */
function allPaths(q: RegisteredQuestionView): string[] {
  const out: string[] = []
  const walk = (node: RegisteredQuestionView["spec"], path: string) => {
    out.push(path)
    node.options?.forEach((option, optIdx) => {
      option.followUps?.forEach((child, fuIdx) => walk(child, `${path}/${optIdx}.${fuIdx}`))
    })
  }
  walk(q.spec, ROOT_PATH)
  return out
}

/** Is this question answered enough to send? Exported for the board card, which shows a count. */
export function questionIsStaged(q: RegisteredQuestionView, answers: ReadonlyMap<string, BlockAnswer>): boolean {
  return nodeAnswered(q.spec, answers.get(ROOT_PATH))
}
