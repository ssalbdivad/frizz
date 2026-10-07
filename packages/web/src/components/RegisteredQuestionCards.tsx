// The surface a REGISTERED question renders on — a question a worker created with the `ask` tool, which
// is a row in `thread_question` rather than a fence in a message. That is the whole difference, and it
// is the reason this file exists at all: a fenced question lives and dies with the message carrying it,
// so it vanishes from view the moment the transcript scrolls or the context is compacted, while a
// registration is still owed an answer tomorrow. So these cards do NOT ride the transcript on their own:
// they render at the rest that asked them, or a later one whose ```awaiting fence names them under
// `questions:` (lib/questionAnchor, upstream e157817a, 2026-10-05), and in the slot of an empty
// ```question qst_… marker the worker wrote into its handoff (lib/questionShadow PLACEMENT). The fork drew
// every open card at the bottom of the newest handoff from 2026-09-28 until this merge took upstream's
// placement instead.
//
// The CARD is the shared one (QuestionBlockCard); only the plumbing is new. What a registration adds
// over the other two producers is the STATIC TREE: an option may carry follow-ups that become live only
// once that option is picked, so one registration renders as a stack of cards that grows as it is
// answered. lib/registeredQuestion.ts performs that walk; nothing here decides which nodes are live.
//
// ONE QUESTION AT A TIME (2026-09-29, maintainer: "the agent should receive the answer to one question
// at a time so it can start working but the remaining questions … should stay there"). A question is SENT
// the moment it is complete — a single-choice pick that opens no follow-up, the last of its follow-ups
// answered, an Enter in its own box, a multi confirmed with Enter or Send — and the rest stay open and
// owed where they are. The questions of one `ask` are independent by contract (a dependent one is a
// `followUps` entry), which is what makes one answer actionable alone. Send answers survives only as the
// on-purpose send of whatever is half-filled (typed and not Entered, a multi not confirmed), and a typed
// reply still carries anything staged ahead of itself.
//
// ONE ANSWERING STATE PER THREAD, however many mounts. The staged picks, what has been sent, and the
// prompt box that carries staged answers ahead of a reply all have to agree, so the state cannot live
// in the stack that draws the cards. `useRegisteredAnswering` holds it for the whole thread; the surface
// mounts it ONCE (RegisteredAnsweringProvider) and every stack on that surface reads it through context.
// A stack mounted with no provider above it (a surface that draws one stack) owns a state of its own.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { questionsOwed, type QuestionAnswer, type RegisteredQuestionView, type SettledQuestionView, type ThreadView } from "@frizz/shared"
import { rpc, type Api } from "../api/rpc.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir } from "../lib/drafts.ts"
import { clearSteered, clearSteeredIn, markSteered, markSteeredIn } from "../lib/steering.ts"
import type { BlockAnswer } from "../lib/questionBlocks.ts"
import type { PairedAnswer } from "../lib/answersMessage.ts"
import { ROOT_PATH, liveQuestionNodes, nodeAnswered, questionComplete, registeredAnswer, settledQuestionNodes } from "../lib/registeredQuestion.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { QueueDismissContext } from "./ChatView.tsx"
import { QuestionBlockCard, focusQuestionNode } from "./QuestionBlockCard.tsx"
import { revealInDrawerTranscript } from "../lib/drawerReveal.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { CompactQuestionList, usePhoneQuestions } from "./PhoneQuestionCards.tsx"

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
  /** Questions the × took off the card, ahead of the board read that drops them. */
  dismissed: ReadonlySet<string>
  /** The countdown's ×: Frizz will not take the recommended option for `id`; it waits for the human. */
  cancelDefault: (id: string) => void
  /** Send ONE question's staged answer — what completing a question does. Nothing staged: nothing sent. */
  commit: (q: RegisteredQuestionView) => void
  /** Send EVERY staged answer on the thread: the on-purpose Send answers, and a typed reply carrying what
   *  is staged ahead of itself. `then` runs once they have LANDED, never on a failure: the prompt box
   *  passes its own send here, so a reply typed with answers staged goes out after them rather than
   *  instead of them. */
  submit: (then?: () => void) => void
  /** Enter inside one of `q`'s cards (`grid` is that node's options grid): walk to `q`'s next unanswered
   *  follow-up; with none left, send `q` — whatever it holds, which is how a half-filled one is sent on
   *  purpose — and move to the next unanswered question. Enter never sends another question. */
  enter: (q: RegisteredQuestionView, grid: HTMLElement) => void
  /** Every question this state has sent and the server has not refused, as its greyed card will draw it.
   *  A surface that keeps the answered card in place (the queue card) reads it; the thread page draws its
   *  own from the settled list. */
  sent: ReadonlyMap<string, SettledQuestion>
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
  api: Pick<Api, "answerQuestions" | "dismissQuestions" | "holdQuestionDefault">
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
  // What this state has sent, by id — kept until the server refuses it, so a question is never staged or
  // sent twice however long the board takes to drop it, and so a surface can grey it where it stood.
  const [sent, setSent] = useState<ReadonlyMap<string, SettledQuestion>>(() => new Map())
  // Sends in flight. Several can be at once now — the human picks the next card while the last one's
  // round-trip is still out — so one mutation's `isPending` no longer says it.
  const [inFlight, setInFlight] = useState(0)
  // THE QUEUE CARD DISSOLVES ON SEND, like every other action on it. Answering is the same commitment as
  // a fenced Send answers or a composer steer — both of which take the card out of the queue the instant
  // the human commits, without waiting on the round-trip (see useLiveAnswering's onSent) — and this was
  // the one send that did not, so a card answered on a loaded machine sat there for the seconds it took
  // the board to catch up, which is the window its answer rendered twice in (2026-09-01). …UNLESS the
  // card still asks something: then it HOLDS its place (see `sendPairs`). Null on the thread page, where
  // there is no card to dismiss.
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

  // What a send would carry, per question — never one already sent.
  const stagedPairs = questions.flatMap((q) => {
    if (sent.has(q.id)) return []
    const built = registeredAnswer(q, answersOf(q))
    return built ? [{ q, answer: built }] : []
  })
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
    onError: (cause, answers) => {
      // The card faded (or greyed) on click; the answer did not land, so put it back rather than leaving
      // the human looking at a queue that quietly swallowed their reply. Same reversal an optimistic
      // Mark-as-done makes when the server declines it.
      queueDismiss?.cancel()
      if (slug && scope) clearSteeredIn(scope.projectId, slug)
      else if (slug) clearSteered(slug)
      const ids = new Set(answers.map((a) => a.questionId))
      setSent((prev) => new Map([...prev].filter(([id]) => !ids.has(id))))
      setError(errorText(cause))
    },
    // Server truth replaces the optimistic settled cards either way: on success it carries the real
    // `settledAt`, and on failure it no longer holds them, which brings the open card back.
    onSettled: () => {
      setInFlight((n) => Math.max(0, n - 1))
      if (slug) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug, scope?.projectId) })
    },
  })
  // THE × TAKES THE QUESTION OFF THE CARD ON CLICK, not on the board read that follows. That read is a
  // poll on the All queues page, and a project still reopening after a server restart is drawn from
  // its LAST poll for up to a minute (AllQueues useLastKnownQueues) — so the dismissal landed on the
  // first click and the question stayed on the card, and every later × was a silent no-op on a row no
  // longer open (2026-10-06, `@logo-design`: "have clicked x multiple times over ~30 seconds"). Back on
  // screen only if the server still lists it open — a refusal — or the request fails.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const undismiss = (id: string) =>
    setDismissed((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  const dismiss = useMutation({
    mutationFn: async (id: string) => api.dismissQuestions({ slug: slug!, ids: [id] }),
    onMutate: (id) => setDismissed((prev) => new Set(prev).add(id)),
    onSuccess: (result, id) => {
      if (result.open.some((q) => q.id === id)) undismiss(id)
    },
    onError: (cause, id) => {
      undismiss(id)
      setError(errorText(cause))
    },
  })
  // THE DEFAULT HOLDS WHILE THE HUMAN IS ON THE CARD. A question that would take its recommended option
  // (`defaultsAt`) is told about every pick, toggle and keystroke — at most once per ENGAGE_PING_MS, well
  // inside the server's grace — so the default cannot fire under someone halfway through answering. A
  // lost ping is not worth an error line: the next interaction sends another.
  const hold = useMutation({
    mutationFn: async (input: { id: string; action: "engage" | "cancel" }) => api.holdQuestionDefault({ slug: slug!, ...input }),
    onError: (cause, input) => {
      if (input.action === "cancel") setError(errorText(cause))
    },
  })
  const engagedAt = useRef(new Map<string, number>())
  const engage = (q: RegisteredQuestionView) => {
    if (!slug || !q.defaultsAt) return
    const now = Date.now()
    if (now - (engagedAt.current.get(q.id) ?? 0) < ENGAGE_PING_MS) return
    engagedAt.current.set(q.id, now)
    hold.mutate({ id: q.id, action: "engage" })
  }

  const sendPairs = (pairs: typeof stagedPairs, then?: () => void) => {
    if (!slug || pairs.length === 0) return
    setError(undefined)
    const ids = new Set(pairs.map((pair) => pair.q.id))
    // Local truth FIRST, then the network — the ordering every other send on this card obeys, and the
    // whole of what "the card goes away when I answer it" means on a machine under load. But a card that
    // still asks something HOLDS (David 2026-09-29: "the remaining questions … should stay there"):
    // the worker starts on this answer and leaves the queue for it, and the card stays in its place, live,
    // with the answered question greyed and the rest answerable, until the last one is sent.
    const stillOpen = questions.some((q) => !ids.has(q.id) && !sent.has(q.id))
    if (stillOpen) queueDismiss?.hold?.()
    else queueDismiss?.dismiss()
    // …AND THE RAIL ROW GOES TO WORK WITH IT. Every answer wakes the worker (the scheduler delivers it),
    // so this is a steer in all but name, and it takes the steer's overlay: without it the row dropped
    // its question mark on the board push, sat in the queue wearing the at-rest ellipsis, and only moved
    // to the running band once the delivery landed (lib/steering.ts).
    // On another project's card the record is that project's (markSteeredIn): a bare slug there would
    // set the page project's thread of the same name to work.
    if (scope) markSteeredIn(scope.projectId, slug)
    else markSteered(slug)
    // THE CARD GREYS IN PLACE ON SEND, before the round-trip: the answered question joins the settled
    // list now, and the surface stops drawing the open card for any id that list holds (see
    // withoutSettledQuestions). Waiting for the server instead left a beat where the open card had gone
    // with the board push and the settled one had not arrived — the card blinking out and back.
    const key = settledQuestionsKey(slug, scope?.projectId)
    void queryClient.cancelQueries({ queryKey: key })
    const settledAt = new Date().toISOString()
    const settled = pairs.map(({ q, answer }): SettledQuestion => ({ id: q.id, spec: q.spec, askedAt: q.askedAt, ...(q.keptAt ? { keptAt: q.keptAt } : {}), settledAt, answer, pending: true }))
    queryClient.setQueryData<SettledQuestion[]>(key, (prev) => [...(prev ?? []).filter((s) => !ids.has(s.id)), ...settled])
    setSent((prev) => new Map([...prev, ...settled.map((s) => [s.id, s] as const)]))
    setInFlight((n) => n + 1)
    // `mutateAsync`, not per-call callbacks: the queue card dissolves on this very click and unmounts,
    // and a mutate()-scoped onSuccess is dropped with the observer — the reply riding `then` with it.
    send.mutateAsync(pairs.map((pair) => pair.answer)).then(() => then?.(), () => {})
  }
  const commit = (q: RegisteredQuestionView) => sendPairs(stagedPairs.filter((pair) => pair.q.id === q.id))
  const submit = (then?: () => void) => sendPairs(stagedPairs, then)

  // A PICK THAT COMPLETES ITS QUESTION SENDS IT (David 2026-09-29: "the agent should receive the
  // answer to one question at a time so it can start working"). Before 2026-09-29 a pick sent only once
  // EVERY owed question was answered, and before that only Send answers sent at all — so the worker sat
  // idle while the human read the rest.
  //
  // Only a SINGLE-choice pick arms it. That click is the whole answer; a multi toggle is one of several,
  // and a keystroke is half a word, so neither can say "done" — Enter (see `enter`) and Send answers stay
  // the send for those. Read on the render AFTER the pick, because completeness includes the follow-ups
  // the pick just opened: a pick that opens some waits for them, and the pick that answers the last one
  // sends the whole question. And it holds off while the thread's prompt box has a draft: that human is
  // mid-note, and their Enter sends both (ThreadComposerBox).
  const autoSend = useRef<string | null>(null)
  useEffect(() => {
    const id = autoSend.current
    if (id === null) return
    autoSend.current = null
    const q = questions.find((entry) => entry.id === id)
    if (!q || sent.has(q.id) || !questionComplete(q.spec, answersOf(q))) return
    const drafting = slug ? (draftStore.get(draftKey.followUp(projectDir, slug, thread?.sessionId)) ?? "").trim() !== "" : false
    if (!drafting) commit(q)
  })

  const enter = (q: RegisteredQuestionView, grid: HTMLElement) => {
    // This question's own cards first — the root, then the follow-ups its pick opened, in order.
    const article = grid.closest<HTMLElement>("[data-question-id]")
    const own = article ? [...article.querySelectorAll<HTMLElement>("[data-answerable-question]")] : [grid]
    const nextOwn = own.slice(own.indexOf(grid) + 1).find((node) => node.dataset.answered === "false")
    if (nextOwn) {
      focusQuestionNode(nextOwn)
      return
    }
    // None left: send it, and go on to the next unanswered question of the set — found BEFORE the send,
    // which greys this one out from under the walk. After this question first, then wrapping.
    const set = grid.closest("[data-question-set]")
    const others = set ? [...set.querySelectorAll<HTMLElement>("[data-answerable-question]")].filter((node) => !article?.contains(node)) : []
    const after = others.filter((node) => article && article.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
    const next = [...after, ...others.filter((node) => !after.includes(node))].find((node) => node.dataset.answered === "false")
    commit(q)
    if (next) focusQuestionNode(next)
  }

  return {
    slug,
    answerFor,
    answersOf,
    onChip: (q, path, isMulti, optIdx) => {
      engage(q)
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
          if (pick.chosen !== optIdx) autoSend.current = q.id
        }
        return next
      })
    },
    onText: (q, path, isMulti, text) => {
      if (!slug) return
      engage(q)
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
    dismissed,
    cancelDefault: (id) => hold.mutate({ id, action: "cancel" }),
    commit,
    submit,
    enter,
    sent,
    staged: stagedPairs.length,
    sending: inFlight > 0,
    error,
  }
}

/** How often a card re-reports the human working on it. Well under QUESTION_DEFAULT_ENGAGED_GRACE_MS,
 *  so steady typing keeps the deadline pushed out. */
const ENGAGE_PING_MS = 30_000

// ---- ANSWERED questions: the card stays where it stood, greyed, showing only the answer ----

/** An answered registration as the transcript draws it. `pending` marks one this tab just sent and has
 *  not yet read back — see lib/settledQuestions. */
export type SettledQuestion = SettledQuestionView & { pending?: true }
const NO_SETTLED: readonly SettledQuestion[] = []
/** The cache entry a thread's answered questions live under. A thread of the PAGE's project keys by slug
 *  (the page's query scope says whose); a thread drawn on another project's queue card names its project
 *  in the key (`ofProject`, lib/queryKeyScope.ts), since on All projects the page's scope is not the
 *  card's and two projects' same-named threads would otherwise share one list. The answering state writes
 *  its optimistic entries through the same function, so the card and its stacks always meet. */
export const settledQuestionsKey = (slug: string, projectId?: string) =>
  projectId === undefined ? (["settledQuestions", slug] as const) : (["ofProject", projectId, "settledQuestions", slug] as const)

/** The thread's answered questions. Read per thread rather than off the board (see the shared
 *  SettledQuestionView), and re-read on the one board event that can add to it: a question leaving the
 *  OPEN list — answered here, in another tab, or on the queue card. A withdrawal or a dismissal re-reads
 *  too, and finds nothing new; that costs one indexed SELECT.
 *
 *  `scope` reads them through the thread's own project (the queue card's, like RegisteredAnsweringScope),
 *  and `enabled: false` holds the read for a surface that has nothing to place them in yet — the queue
 *  card reads them only once it is reading the transcript they are placed in. Both absent on the drawer. */
export function useSettledQuestions(
  thread: ThreadView | undefined,
  opts: { scope?: { api: Pick<Api, "threadSettledQuestions">; projectId: string }; enabled?: boolean } = {},
): readonly SettledQuestion[] {
  const slug = thread?.id
  const { scope, enabled = true } = opts
  const api = scope?.api ?? rpc
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: settledQuestionsKey(slug ?? "", scope?.projectId),
    queryFn: async (): Promise<SettledQuestion[]> => (await api.threadSettledQuestions({ slug: slug! })).questions,
    enabled: Boolean(slug) && enabled,
    refetchOnWindowFocus: false,
  })
  const openIds = (thread?.questions ?? []).map((q) => q.id).join(" ")
  const previous = useRef(openIds)
  useEffect(() => {
    const before = previous.current
    previous.current = openIds
    if (!slug || before === openIds) return
    const now = new Set(openIds.split(" "))
    if (before.split(" ").some((id) => id && !now.has(id))) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug, scope?.projectId) })
  }, [openIds, queryClient, slug, scope?.projectId])
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
    <article data-question-id={s.id} data-settled-question aria-label="Answered question" className={`${QUESTION_CONTAINER} flex min-w-0 flex-col gap-2 opacity-60`}>
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className={`${BRANCH_RULE} flex flex-col gap-2`}>
          {branch.map((node) => (
            <div key={node.path} className={node.depth > 2 ? BRANCH_RULE : undefined}>
              {card(node)}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

// A REGISTERED QUESTION IS ITS OWN SIZE CONTAINER, so its follow-up branch can tighten to the width the
// card actually has (a 300px VS Code sidebar's drawer gives it ~252px, a phone's ~330, the desktop
// drawer's 672). Each level of the branch cost 24px of indent (`ml-3 pl-3`) on top of the nested card's
// own 32px of padding, leaving a depth-3 follow-up ~160px of label at 300. Under 24rem of card the rule
// keeps its place and the indent halves (6px + 8px); anywhere wider it is the desktop's 12 + 12.
const QUESTION_CONTAINER = "@container/question"
const BRANCH_RULE = "ml-3 border-l border-border pl-3 @max-[24rem]/question:ml-1.5 @max-[24rem]/question:pl-2"

/** A follow-up the human's own pick just opened. It grows the card BELOW the fold of a drawer's transcript
 *  — at a 300px VS Code sidebar under the floating "Jump to latest" control, over its "Something else…"
 *  rows — so it reveals itself, clear of that control, in the drawer's transcript only
 *  (lib/drawerReveal.ts). Only a node that mounts AFTER its card did (`reveal`): the branch a card opens
 *  with is where the human left it, and a card re-mounted by the virtualizer must not drag the transcript. */
function BranchNode({ reveal, className, children }: { reveal: ((el: HTMLElement) => void) | null; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // Mount-only on purpose: `reveal` is read at the moment the node appears, never again. It only queues
  // the node; the card reveals everything one pick opened as one span (RegisteredQuestionCard).
  useEffect(() => {
    if (reveal && ref.current) reveal(ref.current)
  }, [])
  return <div ref={ref} className={className}>{children}</div>
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
  const phone = usePhoneQuestions()
  // False through the card's first render, true after: a follow-up that mounts later was opened by a pick.
  // Those queue themselves in `opened` as they mount, and the effect below — after every child's, in the
  // same commit — reveals them together and clears the queue.
  const mounted = useRef(false)
  const opened = useRef<HTMLElement[]>([])
  useEffect(() => {
    mounted.current = true
  }, [])
  useEffect(() => {
    if (opened.current.length === 0) return
    revealInDrawerTranscript(opened.current)
    opened.current = []
  })
  const a = given ?? shared
  if (!a || !a.slug) return null
  // On the phone thread page the card is a reading surface; the sheet answers it (PhoneQuestionCards).
  const countdown = q.defaultsAt ? <DefaultCountdown at={q.defaultsAt} to={q.defaultsTo} onCancel={() => a.cancelDefault(q.id)} /> : null
  if (phone) return <>
    <CompactQuestionList questions={[q]} />
    {countdown}
  </>
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
        onSubmit: () => a.submit(),
        onEnter: (grid) => a.enter(q, grid),
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
    <article data-question-id={q.id} className={`${QUESTION_CONTAINER} flex min-w-0 flex-col gap-2`}>
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className={`${BRANCH_RULE} flex flex-col gap-2`}>
          {branch.map((node) => (
            <BranchNode key={node.path} reveal={mounted.current ? (el) => opened.current.push(el) : null} className={node.depth > 2 ? BRANCH_RULE : undefined}>
              {card(node)}
            </BranchNode>
          ))}
        </div>
      )}
      {countdown}
    </article>
  )
}

/** THE DEFAULT'S COUNTDOWN — a caption under the card, not chrome on it: the card's own title-row × is
 *  the dismiss, and a second × beside it would read as the same control. Minutes only, on the page's
 *  30s clock (a ticking seconds digit would pull the eye off the question it sits under); `<1m` for the
 *  last minute, as the shell-budget reading spells it. Its × turns the default off for this question. */
function DefaultCountdown({ at, to, onCancel }: { at: string; to?: string; onCancel: () => void }) {
  const now = useNowMs()
  const left = Date.parse(at) - now
  const reading = left < 60_000 ? "<1m" : `${Math.ceil(left / 60_000)}m`
  return (
    // The × is the caption's own handle: at 12px lucide's X paints 6 of its 12 box px, and with `p-1`
    // the box put 11.63px of ink gap after the text under `gap-1` (sans, measured 2026-10-05) — detached.
    // At 4.70px it read as "8m×", a multiplication sign; no gap and `-ml-px` measure ~6.7px, keeping the
    // 20px hit area. Vertically `items-center` lands the ink 0.50px from the cap band's centre — left alone.
    <div data-question-default className="flex items-center px-4 text-[12px] leading-4 text-muted-70">
      {/* Short enough to stay on one line beside its × in a 380px card; the tooltip says the rest. */}
      {/* `to` names a FALLBACK: the recommendation acts outside this machine, so the default takes the
          first option that does not, and the countdown must not claim it takes the recommendation. */}
      {to ? (
        <span className="min-w-0 truncate" title={`Unless it is answered first. The recommended option is never picked for the human: it acts outside this machine.`}>
          Picks “{to}” in {reading}
        </span>
      ) : (
        <span title="Unless it is answered first">Picks the recommended option in {reading}</span>
      )}
      <button
        type="button"
        data-cancel-question-default
        aria-label="Keep waiting for an answer"
        title="Keep waiting for an answer"
        onClick={onCancel}
        className="icon-hover-outline -my-1 -ml-px flex rounded-md p-1 outline-none transition-colors hover:bg-elevated hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  )
}

export function RegisteredQuestionStack({
  thread,
  questions: only,
  inFlight = null,
  keepAnswered = false,
  className = "",
}: {
  thread: ThreadView | undefined
  // WHICH of the thread's open questions this mount draws. Every surface hangs a question after the REST
  // THAT CLAIMS IT rather than at the transcript's tail (lib/questionAnchor questionsByAnchor), so one
  // thread can have several of these mounted at different depths — each handed its own group.
  questions?: readonly RegisteredQuestionView[]
  // THE ANSWER ALREADY SENT AND NOT YET ON SCREEN ANYWHERE ELSE — the rows of `thread.answersInFlight`
  // the transcript is not already drawing (lib/answersMessage.unrenderedAnswers). Passed IN rather than
  // read off the thread here, because deciding it needs the transcript this stack is pinned beside, and
  // because only ONE mount may draw it: the answer is the human's newest turn and belongs at the tail
  // however deep the questions themselves sit. An anchored mount simply omits it.
  inFlight?: PairedAnswer[] | null
  // KEEP EACH ANSWERED QUESTION IN ITS SLOT, greyed, after the board has dropped it — for a surface that
  // draws nothing else of the answer: the queue card, which now HOLDS while it still asks something
  // (useRegisteredAnswering sendPairs). Without it the answered card left the stack on the board push
  // and every card under it moved up under the human's cursor. The thread page does not want it: it
  // draws the greyed card itself, from the settled list, at the rest it was answered at.
  keepAnswered?: boolean
  className?: string
}) {
  const slug = thread?.id
  // A provider above this stack owns the state; without one, this stack does (a surface that draws only
  // one stack has no reason to mount the provider).
  const shared = useContext(RegisteredAnsweringContext)
  const own = useRegisteredAnswering(shared ? undefined : thread)
  const a = shared ?? own
  const offered = only ?? thread?.questions ?? []
  const listed = a.dismissed.size > 0 ? offered.filter((q) => !a.dismissed.has(q.id)) : offered
  // Every question this stack has drawn, in the order it drew them, so one answered and since dropped by
  // the board keeps its slot (`keepAnswered`) — and a question asked since joins at the bottom.
  const drawn = useRef<readonly RegisteredQuestionView[]>([])
  let questions: readonly RegisteredQuestionView[] = listed
  if (keepAnswered) {
    const live = new Map(listed.map((q) => [q.id, q]))
    const kept = drawn.current.flatMap((q) => (live.has(q.id) ? [live.get(q.id)!] : a.sent.has(q.id) ? [q] : []))
    questions = [...kept, ...listed.filter((q) => !kept.some((k) => k.id === q.id))]
    drawn.current = questions
  }
  const phone = usePhoneQuestions()

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

  if (phone) {
    return (
      <section
        data-registered-questions
        aria-label={`${questions.length} question${questions.length === 1 ? "" : "s"} waiting for an answer`}
        className={`flex min-w-0 flex-col gap-3 ${className}`}
      >
        <CompactQuestionList questions={questions} />
        {/* The sheet closes on Send, so a refusal has to surface HERE, beside the questions it restored. */}
        {a.error && <div role="alert" className="break-words text-[13px] leading-snug text-danger-soft">{a.error}</div>}
        {a.sending && <div role="status" aria-live="polite" className="text-[13px] leading-snug text-muted">Sending…</div>}
      </section>
    )
  }

  return (
    <section
      data-registered-questions
      // The batch a card's Enter walks before it sends (QuestionBlockCard advanceOrSubmit).
      data-question-set
      aria-label={(() => {
        const waiting = questions.filter((q) => !a.sent.has(q.id)).length
        return `${waiting} question${waiting === 1 ? "" : "s"} waiting for an answer`
      })()}
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      {questions.map((q) => {
        // Sent from here: greyed in its own slot at once, before the round-trip, the way the thread page
        // greys it from the settled list — never drawn open a second time while the board catches up.
        const sentAs = a.sent.get(q.id)
        return sentAs ? <SettledQuestionCard key={q.id} s={sentAs} /> : <RegisteredQuestionCard key={q.id} q={q} answering={a} />
      })}
      {a.error && <div role="alert" className="break-words text-[11px] leading-snug text-danger-soft">{a.error}</div>}
      {a.sending && (
        <div role="status" aria-live="polite" className="text-[11px] leading-snug text-muted">Sending…</div>
      )}
      {/* HUNG OFF THE QUESTIONS IT SENDS, not spaced like one more of them: 8px under the last card
          against the stack's 12px rhythm. On the queue card the reply box sits 17px below, and the
          stack's plain 12px there read as a button floating between the two, half an appendage of
          the box (the rule scripts/verify-open-ask-composer.mjs holds, from the maintainer's
          2026-07-22 "the spacing is insane": ≤10px up, at least 1.5x that down). Both marks here are
          filled or bordered boxes, so the box gap IS the ink gap.

          ONLY WHILE SOMETHING IS HALF-FILLED (2026-09-29). A complete question sends itself, so this
          is no longer the gate every answer passes through; it is the on-purpose send of what nothing
          else sends — text typed and not Entered, a multi's toggles, a branch left partly answered.
          Drawn disabled at all times, it read as the step still owed after every pick. */}
      {a.staged > 0 && (
        <div className="-mt-1 flex justify-start">
          <button
            type="button"
            data-send-answers
            disabled={a.sending}
            onClick={() => a.submit()}
            onMouseDown={(e) => e.preventDefault()}
            className="button-outline rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
          >
            {a.staged === 1 ? "Send answer" : "Send answers"}
          </button>
        </div>
      )}
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
