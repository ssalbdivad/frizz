import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, SpinoffView, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { ThreadHandleLink } from "./MentionLinks.tsx"
import { SpinoffCard, SpinoffOf, SpinoffOriginCard, spinoffCardState } from "./Spinoff.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"

// The spinoff's two dedicated cards (David 2026-09-30: "a special UI affordance for referencing
// spinoff context", "dedicated UI and link to the spinoff … mention the spinoff by name with the new @
// feature"), rendered against a stubbed board. ChatView itself cannot load under node (it imports CSS),
// so its routing is pinned over its source at the bottom and driven for real in Spinoff.e2e.test.ts.

const thread = (over: Partial<ThreadView> & { id: string; title: string }): ThreadView => ({
  kind: "session", backend: "claude", titleAuto: false, titleLocked: true, status: "active", runtime: "turn-idle", subAgents: [],
  ...over,
}) as unknown as ThreadView

const edge = (over: Partial<SpinoffView> = {}): SpinoffView => ({
  id: "spn_0123456789abcdef", parentSlug: "live-sub-agents", childSlug: "evaluate-addresses", instructions: "Is it worth keeping?", createdAt: 0, ...over,
})

function board(threads: ThreadView[]): void {
  store.board = { threads, projectSlug: "frizz" } as unknown as BoardSnapshot
}

// The request card takes a queued send back through the transcript cache, so it needs a query client.
function inThread(slug: string, node: ReactNode): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ThreadSlugContext.Provider, { value: slug }, node)))
}

test("a request is started once it has a child, starting while it can still become one, and unstarted at rest", () => {
  const pending = edge({ childSlug: null })
  assert.equal(spinoffCardState(edge(), {}), "started")
  assert.equal(spinoffCardState(pending, { queued: true }), "starting")
  assert.equal(spinoffCardState(pending, { runtime: "running" }), "starting")
  assert.equal(spinoffCardState(pending, { runtime: "spawning" }), "starting")
  assert.equal(spinoffCardState(undefined, { queued: true }), "starting", "a send the board has not caught up with yet")
  assert.equal(spinoffCardState(pending, { runtime: "turn-idle" }), "unstarted")
  assert.equal(spinoffCardState(pending, { runtime: "exited" }), "unstarted")
  // A child outranks a stale queued flag: the ledger echo can briefly outlive the dispatch.
  assert.equal(spinoffCardState(edge(), { queued: true, runtime: "running", deliveryState: "unconfirmed" }), "started")
})

// Review 2026-09-30: "didn't start" only once the worker has really finished a turn holding the request.
test("the ledger's state decides a request still in it: unconfirmed is said, and a delivered send is starting whatever the runtime reads", () => {
  const pending = edge({ childSlug: null })
  // No receipt inside the ledger's window: not a spinner for an hour, and not a claim it failed either.
  assert.equal(spinoffCardState(pending, { queued: true, deliveryState: "unconfirmed", runtime: "turn-idle" }), "unconfirmed")
  // The provider took it straight into a turn whose record is not on disk yet — the tailer still reads idle.
  assert.equal(spinoffCardState(pending, { queued: false, deliveryState: "delivered", runtime: "turn-idle" }), "starting")
  assert.equal(spinoffCardState(pending, { deliveryState: "pending", runtime: "turn-idle" }), "starting")
  assert.equal(spinoffCardState(pending, { deliveryState: "enqueued", runtime: "exited" }), "starting")
})

test("a turn paused on the human is waiting, never didn't start — nor starting, which it is not", () => {
  const pending = edge({ childSlug: null })
  assert.equal(spinoffCardState(pending, { runtime: "perm-prompt" }), "waiting")
  // A Codex approval reads running AND a typed interaction at once; the pause is the truth.
  assert.equal(spinoffCardState(pending, { runtime: "running", blocked: true }), "waiting")
  assert.equal(spinoffCardState(pending, { runtime: "turn-idle", blocked: true }), "waiting", "a native ask the session is frozen on")
  assert.equal(spinoffCardState(pending, { queued: true, runtime: "perm-prompt" }), "waiting", "queued behind a turn that is paused on you")
  // …and unconfirmed still outranks it: that send may never have reached the paused turn at all.
  assert.equal(spinoffCardState(pending, { queued: true, deliveryState: "unconfirmed", runtime: "perm-prompt" }), "unconfirmed")
})

// Review 2026-09-30: an old request with no child must not borrow the runtime of a LATER turn, and one whose
// edge the board no longer carries (its child was forgotten) must not claim it never started.
test("a request a later message superseded reads didn't start whatever the thread does now; one whose edge is gone reads detached", () => {
  const pending = edge({ childSlug: null })
  assert.equal(spinoffCardState(pending, { superseded: true, runtime: "running" }), "unstarted")
  assert.equal(spinoffCardState(pending, { superseded: true, runtime: "perm-prompt", blocked: true }), "unstarted")
  // …but the ledger still owns a send it holds, and a child still wins.
  assert.equal(spinoffCardState(pending, { superseded: true, queued: true, runtime: "running" }), "starting")
  assert.equal(spinoffCardState(edge(), { superseded: true }), "started")
  assert.equal(spinoffCardState(undefined, { edgeGone: true, runtime: "running" }), "detached")
  assert.equal(spinoffCardState(undefined, { edgeGone: true, queued: true }), "starting", "a send the board has not caught up with yet")
  assert.equal(spinoffCardState(undefined, { runtime: "turn-idle" }), "unstarted", "no board row to read the edge list from")

  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "running", lastUserAt: "2026-09-30T10:05:00.000Z", spinoffs: [pending] } as Partial<ThreadView> & { id: string; title: string })])
  const old = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x", at: "2026-09-30T10:00:00.000Z" }))
  assert.match(old, /data-spinoff-state="unstarted"/)
  const current = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x", at: "2026-09-30T10:05:00.000Z" }))
  assert.match(current, /data-spinoff-state="starting"/, "the request that IS the newest message is the turn running now")

  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "turn-idle", spinoffs: [] })])
  const detached = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "Is it worth keeping?" }))
  assert.match(detached, /data-spinoff-state="detached"/)
  assert.match(detached, /Is it worth keeping\?/)
  assert.doesNotMatch(detached, /didn(?:'|&#x27;)t start/)
  assert.doesNotMatch(detached, /<a /)
})

test("the parent's card names the child by @handle, links it, and is outlined rather than the human's filled bubble", () => {
  board([
    thread({ id: "live-sub-agents", title: "Live sub agents", spinoffs: [edge()] }),
    thread({ id: "evaluate-addresses", title: "Evaluate addresses", statusLine: "Reading the router" }),
  ])
  const html = inThread("live-sub-agents", createElement(SpinoffCard, { id: edge().id, instructions: "Is it worth keeping?\nBe blunt.", sourceId: "u1" }))
  assert.match(html, /data-spinoff-card="request"/)
  assert.match(html, /data-spinoff="spn_0123456789abcdef"/)
  assert.match(html, /data-frizz-msg="u1"/)
  assert.match(html, /data-spinoff-state="started"/)
  assert.match(html, />Spinoff</)
  assert.match(html, /<a href="\/thread\/evaluate-addresses" title="Evaluate addresses · Reading the router" data-thread-mention="evaluate-addresses"[^>]*>@evaluate-addresses<\/a>/)
  assert.match(html, /Is it worth keeping\?\nBe blunt\./, "the instructions verbatim, breaks intact")
  assert.match(html, /\bborder\b/)
  assert.doesNotMatch(html, /bg-user-bubble/, "an action, not a message: no bubble fill")
})

test("a request without a child reads starting while the worker is at it or the send is queued, and didn't start at rest", () => {
  const pending = edge({ childSlug: null })
  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "running", spinoffs: [pending] })])
  const working = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x" }))
  assert.match(working, /data-spinoff-state="starting"/)
  assert.match(working, /starting…/)
  assert.match(working, /animate-spin/)
  assert.doesNotMatch(working, /<a /)

  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "turn-idle", spinoffs: [pending] })])
  const queued = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x", queued: true }))
  assert.match(queued, /data-spinoff-state="starting"/)
  const resting = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x" }))
  assert.match(resting, /data-spinoff-state="unstarted"/)
  assert.match(resting, /didn(?:'|&#x27;)t start/)
  assert.doesNotMatch(resting, /animate-spin/)
})

test("the card reads the thread's live pause and the ledger's verdict", () => {
  const pending = edge({ childSlug: null })
  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "perm-prompt", spinoffs: [pending] })])
  const waiting = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x" }))
  assert.match(waiting, /data-spinoff-state="waiting"/)
  assert.match(waiting, /waiting on you/)
  assert.doesNotMatch(waiting, /animate-spin/, "nothing is moving")

  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "turn-idle", actionableInteraction: true, spinoffs: [pending] })])
  assert.match(inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x" })), /data-spinoff-state="waiting"/)

  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "turn-idle", spinoffs: [pending] })])
  const unconfirmed = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x", queued: true, deliveryState: "unconfirmed" }))
  assert.match(unconfirmed, /data-spinoff-state="unconfirmed"/)
  assert.match(unconfirmed, /delivery unconfirmed/)
  assert.match(unconfirmed, /text-attention-80/, "the one warning among the states wears the bubble's warning tone")
  assert.doesNotMatch(unconfirmed, /opacity-50/, "and is not dimmed into illegibility")
  assert.doesNotMatch(unconfirmed, /animate-spin/)
  const delivered = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x", deliveryState: "delivered" }))
  assert.match(delivered, /data-spinoff-state="starting"/)
})

// The take-back itself — the click, the provider's confirmation, the card leaving and the dialog reopening
// on the instructions — is driven in the browser (Spinoff.e2e.test.ts): its support gate is a
// useSyncExternalStore whose server snapshot is always false, so static markup cannot show it.
test("a queued request reads as the queued bubble does; one that started does not", () => {
  const pending = edge({ childSlug: null })
  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "running", spinoffs: [pending] })])
  assert.match(inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x", queued: true, deliveryState: "enqueued", deliveryId: `spinoff-${pending.id}` })), /opacity-50/)
  assert.doesNotMatch(inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x", deliveryState: "delivered" })), /opacity-50/)
  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "running", spinoffs: [edge()] })])
  assert.doesNotMatch(inThread("live-sub-agents", createElement(SpinoffCard, { id: edge().id, instructions: "x", queued: true })), /opacity-50/, "a child outranks a stale queued echo")
})

test("the child's card heads it as a spinoff of its parent, with the brief folded beneath", () => {
  board([
    thread({ id: "live-sub-agents", title: "Live sub agents" }),
    thread({ id: "evaluate-addresses", title: "Evaluate addresses", spinoffs: [edge()] }),
  ])
  const html = inThread("evaluate-addresses", createElement(SpinoffOriginCard, {
    instructions: "Is it worth keeping?",
    context: createElement("p", null, "BRIEF-BODY"),
    sourceId: "u0",
  }))
  assert.match(html, /data-spinoff-card="origin"/)
  assert.match(html, /Spinoff of<\/span><a href="\/thread\/live-sub-agents"[^>]*>@live-sub-agents<\/a>/)
  assert.match(html, /Is it worth keeping\?/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /Context from @live-sub-agents/)
  assert.doesNotMatch(html, /BRIEF-BODY/, "collapsed by default: one quiet line, not the brief")
  assert.doesNotMatch(html, /bg-user-bubble/)
})

test("a child card whose edge the board does not carry still heads itself, without naming a parent", () => {
  board([thread({ id: "evaluate-addresses", title: "Evaluate addresses" })])
  const html = inThread("evaluate-addresses", createElement(SpinoffOriginCard, { instructions: "x", context: createElement("p", null, "brief") }))
  assert.match(html, />Spinoff<\/span>/)
  assert.doesNotMatch(html, /Spinoff of/)
  assert.match(html, />Context</)
  // …and a child whose parent wrote no brief has nothing to fold.
  const bare = inThread("evaluate-addresses", createElement(SpinoffOriginCard, { instructions: "x", context: null }))
  assert.doesNotMatch(bare, /data-spinoff-context-toggle/)
})

test("a thread link reads @handle, else the title the board shows, else the slug", () => {
  board([
    thread({ id: "named", title: "Shell budgets" }),
    thread({ id: "sentence", title: "Rework the session-limit banner so the countdown reads in the house grammar" }),
  ])
  assert.match(renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "named" })), />@shell-budgets</)
  assert.match(renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "sentence" })), />Rework the session-limit banner so the countdown reads in the house grammar</)
  const gone = renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "not-on-board" }))
  assert.match(gone, />not-on-board</)
  assert.match(gone, /title="Open thread"/)
  // A surface of ANOTHER project says it has no row rather than letting the page's board answer for a
  // same-named slug.
  assert.match(renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "named", thread: null })), />named</)
})

test("the child's header line is a spinoff of its parent by @handle, and a queue card can point it at its own project", () => {
  const child = thread({ id: "evaluate-addresses", title: "Evaluate addresses", spinoffs: [edge()] })
  board([thread({ id: "live-sub-agents", title: "Live sub agents" }), child])
  assert.match(renderToStaticMarkup(createElement(SpinoffOf, { thread: child })), /Spinoff of <a href="\/thread\/live-sub-agents"[^>]*>@live-sub-agents<\/a>/)
  const elsewhere = renderToStaticMarkup(createElement(SpinoffOf, {
    thread: child,
    resolve: (slug: string) => (slug === "live-sub-agents" ? thread({ id: slug, title: "Other project parent" }) : undefined),
    href: (slug: string) => `/all/nub/thread/${slug}`,
  }))
  assert.match(elsewhere, /href="\/all\/nub\/thread\/live-sub-agents"[^>]*>@other-project-parent</)
  // The PARENT has no header line of this kind — its spinoffs are cards in its chat.
  assert.equal(renderToStaticMarkup(createElement(SpinoffOf, { thread: thread({ id: "live-sub-agents", title: "Live sub agents", spinoffs: [edge()] }) })), "")
})

// ── ChatView's routing, pinned over its source (it cannot load under node) ─────────────────────────
const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

test("Message draws a spinoff request — the transcript's tell or a ledger send's raw envelope — as the card", () => {
  assert.match(chatView, /const spinoff = m\.spinoff \?\? parseSpinoffRequest\(m\.text\)\n\s+if \(spinoff\) return <SpinoffCard id=\{spinoff\.id\} instructions=\{spinoff\.instructions\} at=\{m\.at\} queued=\{m\.queued\} deliveryState=\{m\.deliveryState\} deliveryId=\{m\.deliveryId\} rawText=\{m\.text\}/, "the ledger's state and id reach the card")
})

test("Message draws a child's first turn as the origin card, before the user-bubble fallback", () => {
  const origin = chatView.indexOf("if (m.spinoffOrigin) return <SpinoffOriginCard")
  const bubble = chatView.indexOf("return <UserBubble text={text}")
  assert.ok(origin > 0 && origin < bubble, "the origin branch precedes the bubble")
  assert.match(chatView, /<SpinoffOriginCard instructions=\{m\.spinoffOrigin\.instructions\} context=\{m\.spinoffOrigin\.brief\.trim\(\) \? <ProseHtml md=\{m\.spinoffOrigin\.brief\} wrap \/> : null\}/)
})

test("the thread transcript's message list drops spinoff calls before any reader of it, and Message takes no thread", () => {
  assert.match(chatView, /const startedSpinoffs = startedSpinoffsKey\(thread\)\n\s+const presentationMessages = useMemo\(\(\) => withoutSpinoffCalls\(withoutLiveTranscriptBackgroundTools\(messages\), startedSpinoffs\), \[messages, startedSpinoffs\]\)/)
  assert.doesNotMatch(chatView, /export const Message = memo\(function Message\(\{[^}]*\bthread\b/)
})
