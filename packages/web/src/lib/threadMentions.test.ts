import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectQueue, SubAgentDirectory, ThreadView } from "@frizz/shared"
import { threadHandle } from "@frizz/shared"
import {
  crossProjectMentionCandidates,
  foldAddress,
  foldHandle,
  humpStarts,
  insertMention,
  matchMentions,
  mentionCandidates,
  mentionQueryAt,
  mentionSegments,
  resolveMention,
  resolveSubAgentMention,
  splitMentionQuery,
  subAgentMentionCandidates,
  subAgentMentionStatus,
} from "./threadMentions.ts"

function thread(over: Partial<ThreadView>): ThreadView {
  return {
    id: "t", title: "t", status: "active", mechanism: null, humanBlocked: false, ready: false, dependsOn: [], externalDeps: [],
    agents: [], errors: [], warnings: [], runtime: "turn-idle", unread: false, archived: false, hasPlan: false, subAgents: [],
    bgShells: [], watches: [], questions: [], pendingQuestion: false, kind: "session", state: "open", titleAuto: false,
    ...over,
  } as ThreadView
}

const board = [
  thread({ id: "a", title: "Shell budgets", statusLine: "Tuning the cap", lastAssistantAt: "2026-09-29T10:00:00Z" }),
  thread({ id: "b", title: "Focus mode", lastAssistantAt: "2026-09-29T12:00:00Z" }),
  thread({ id: "c", title: "Budget report", state: "archived", lastAssistantAt: "2026-09-29T13:00:00Z" }),
  thread({ id: "d", title: "A sentence far too long to be any name" }),
  thread({ id: "e", title: "External", foreign: true }),
  thread({ id: "f", title: "Spinning", titleAuto: true, spawnedAt: new Date().toISOString() }),
]

test("mentionCandidates: open threads by recency, then done ones; no self, externals, placeholders or sentences", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(all.map((c) => c.handle), ["focusMode", "shellBudgets", "budgetReport"])
  assert.deepEqual(all.map((c) => c.done), [false, false, true])
  assert.equal(all[1]!.status, "Tuning the cap")
  assert.deepEqual(mentionCandidates(board, "b").map((c) => c.handle), ["shellBudgets", "budgetReport"], "the thread being written into is not offered")
})

test("mentionQueryAt: an @ at a word boundary before the caret, never an email address", () => {
  assert.deepEqual(mentionQueryAt("ask @she", 8), { start: 4, query: "she" })
  assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" })
  assert.deepEqual(mentionQueryAt("(@focus", 7), { start: 1, query: "focus" })
  assert.equal(mentionQueryAt("mail me@host", 12), undefined)
  assert.equal(mentionQueryAt("ask @she about", 14), undefined, "the caret has left the token")
  assert.equal(mentionQueryAt("ask @she", null), undefined)
  assert.equal(mentionQueryAt("a/@b", 4), undefined)
})

test("matchMentions: handle prefix, then a word's prefix, then substring, then letters in order", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(matchMentions(all, "").map((c) => c.handle), ["focusMode", "shellBudgets", "budgetReport"])
  assert.deepEqual(matchMentions(all, "bud").map((c) => c.handle), ["budgetReport", "shellBudgets"])
  assert.deepEqual(matchMentions(all, "SHELL").map((c) => c.handle), ["shellBudgets"])
  assert.deepEqual(matchMentions(all, "fmd").map((c) => c.handle), ["focusMode"])
  assert.deepEqual(matchMentions(all, "zzz"), [])
})

test("insertMention: completes the token in place and leaves the caret after one space", () => {
  assert.deepEqual(insertMention("ask @she", 4, 8, "shellBudgets"), { prose: "ask @shellBudgets ", caret: 18 })
  // Mid-token caret: the rest of the token is replaced, and an existing space is reused.
  assert.deepEqual(insertMention("ask @shxx about", 4, 7, "shellBudgets"), { prose: "ask @shellBudgets about", caret: 18 })
})

test("resolveMention / foldHandle: case, punctuation and a plain plural fold away", () => {
  const all = mentionCandidates(board)
  assert.equal(resolveMention(all, "ShellBudget")?.slug, "a")
  assert.equal(resolveMention(all, "shell-budgets")?.slug, "a")
  assert.equal(resolveMention(all, "nothing"), undefined)
  assert.equal(foldHandle("class"), "class", "a double s is not a plural")
})

test("mentionSegments: a mention that names a thread becomes a link run; anything else stays text", () => {
  const all = mentionCandidates(board)
  const text = "ask @shellBudgets, not @nobody or me@focusMode"
  const segs = mentionSegments(text, all)
  assert.equal(segs.map((s) => s.text).join(""), text, "byte-for-byte")
  assert.deepEqual(segs.filter((s) => s.kind === "mention").map((s) => [s.text, s.kind === "mention" && s.slug]), [["@shellBudgets", "a"]])
  assert.deepEqual(mentionSegments("@focus-mode!", all).map((s) => s.kind), ["mention", "text"])
  // A mention cut short by `/` or `@` is a package or a path, never its first letters (`@shell`).
  assert.deepEqual(mentionSegments("npm i @shellBudgets/core and @shellBudgets@2", all).map((s) => s.kind), ["text"])
})

// ── SUB-AGENTS AFTER THE DOT ─────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-30T12:00:00Z")
// The server's order: live first, then the returned ones newest first. One child has no address (its
// name is a sentence) and one sits under a Workflow.
const directory: SubAgentDirectory = {
  threadHandle: "shellBudgets",
  agents: [
    { id: "t1", label: "Cache keys", address: "shellBudgets.cacheKeys", depth: 1, state: "running", startedAt: "2026-09-30T11:48:00Z" },
    { id: "w1", label: "wave2", address: "shellBudgets.wave2", depth: 1, state: "running", workflow: true, startedAt: "2026-09-30T11:30:00Z" },
    { id: "w1a", label: "impl:W3", address: "shellBudgets.wave2.implW3", parentId: "w1", depth: 2, state: "stale", startedAt: "2026-09-30T11:20:00Z" },
    { id: "t2", label: "Look at every call site of the cap and report back", depth: 1, state: "running" },
    { id: "t3", label: "Cap audit", address: "shellBudgets.capAudit", depth: 1, state: "done", outcome: "completed", finishedAt: "2026-09-30T09:00:00Z" },
    { id: "t4", label: "Cache sweep", address: "shellBudgets.cacheSweep", depth: 1, state: "done", outcome: "failed", finishedAt: "2026-09-28T12:00:00Z" },
  ],
}

test("mentionQueryAt: the query runs on through dots, but a mention never starts with one", () => {
  assert.deepEqual(mentionQueryAt("ask @shellBudgets.", 18), { start: 4, query: "shellBudgets." })
  assert.deepEqual(mentionQueryAt("ask @shellBudgets.ca", 20), { start: 4, query: "shellBudgets.ca" })
  assert.deepEqual(mentionQueryAt("@a.wave2.im", 11), { start: 0, query: "a.wave2.im" })
  assert.equal(mentionQueryAt("ask @.", 6), undefined, "a leading dot is not a mention")
  assert.equal(mentionQueryAt("ask @.ca", 8), undefined)
  assert.equal(mentionQueryAt("see me.@x", 9), undefined, "an @ right after a dot is not at a word boundary")
})

test("splitMentionQuery: a plain query is untouched; a dotted one splits at its first dot", () => {
  assert.equal(splitMentionQuery("shellBud"), undefined)
  assert.deepEqual(splitMentionQuery("shellBudgets."), { head: "shellBudgets", rest: "" })
  assert.deepEqual(splitMentionQuery("shellBudgets.wave2.im"), { head: "shellBudgets", rest: "wave2.im" })
})

test("humpStarts: the segment after a dot starts a word, whatever its case", () => {
  assert.deepEqual(humpStarts("shellBudgets"), [0, 5])
  assert.deepEqual(humpStarts("portTheParser.cacheKeys"), [0, 4, 7, 14, 19])
  assert.deepEqual(humpStarts("a.B"), [0, 2], "an uppercase segment start is counted once")
})

test("subAgentMentionCandidates: every addressed child, live before returned, each dimmed with how it stands", () => {
  const subs = subAgentMentionCandidates("a", directory, NOW)
  assert.deepEqual(subs.map((c) => c.handle), ["shellBudgets.cacheKeys", "shellBudgets.wave2", "shellBudgets.wave2.implW3", "shellBudgets.capAudit", "shellBudgets.cacheSweep"], "the sentence-named child has no address and is not offered")
  assert.deepEqual(subs.map((c) => c.done), [false, false, false, true, true])
  assert.deepEqual(subs.map((c) => c.subAgentId), ["t1", "w1", "w1a", "t3", "t4"])
  assert.ok(subs.every((c) => c.slug === "a"), "a sub-agent candidate names its thread's slug")
  assert.deepEqual(subs.map((c) => c.status), ["running 12m", "running 30m", "stale 40m", "returned 3h ago", "failed 2d ago"])
  // The server's order is not trusted blindly: a returned child listed early still lands after the live.
  const shuffled = { ...directory, agents: [directory.agents[4]!, ...directory.agents.slice(0, 4)] }
  assert.deepEqual(subAgentMentionCandidates("a", shuffled, NOW).map((c) => c.done), [false, false, false, true])
})

test("subAgentMentionStatus: the house duration grammar, and the child-op row's words for how it ended", () => {
  assert.equal(subAgentMentionStatus({ state: "running", startedAt: "2026-09-30T11:59:22Z" }, NOW), "running 38s")
  assert.equal(subAgentMentionStatus({ state: "rested", startedAt: "2026-09-30T11:00:00Z" }, NOW), "rested")
  assert.equal(subAgentMentionStatus({ state: "done", outcome: "killed", finishedAt: "2026-09-30T11:20:00Z" }, NOW), "stopped 40m ago")
  assert.equal(subAgentMentionStatus({ state: "done", outcome: "completed" }, NOW), "returned", "no instant, no age")
  assert.equal(subAgentMentionStatus({ state: "running" }, NOW), "running")
})

test("matchMentions over sub-agents: ranked on the address below the thread, dots kept", () => {
  const subs = subAgentMentionCandidates("a", directory, NOW)
  const handles = (rest: string) => matchMentions(subs, rest).map((c) => c.handle)
  assert.deepEqual(handles(""), subs.map((c) => c.handle), "`@shellBudgets.` offers every child, live first")
  assert.deepEqual(handles("ca"), ["shellBudgets.cacheKeys", "shellBudgets.capAudit", "shellBudgets.cacheSweep"], "a prefix of the child, live before returned")
  assert.deepEqual(handles("cache"), ["shellBudgets.cacheKeys", "shellBudgets.cacheSweep"])
  assert.deepEqual(handles("keys"), ["shellBudgets.cacheKeys"], "a word inside the child's handle")
  assert.deepEqual(handles("wave2.im"), ["shellBudgets.wave2.implW3"], "a dot typed below the thread separates the same segments")
  assert.deepEqual(handles("impl"), ["shellBudgets.wave2.implW3"], "the segment after a dot is a word start")
  assert.deepEqual(handles("shell"), [], "the head was already typed; it is not matched again")
})

test("matchMentions over threads: a query with no dot behaves exactly as before", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(matchMentions(all, "bud").map((c) => c.handle), ["budgetReport", "shellBudgets"])
  assert.deepEqual(matchMentions(all, "shell-budgets").map((c) => c.handle), ["shellBudgets"], "punctuation still folds away")
})

test("a dotted query's head resolves to a thread by the same fold a plain mention uses", () => {
  const all = mentionCandidates(board)
  const head = (query: string) => {
    const split = splitMentionQuery(query)
    return split && resolveMention(all, split.head)?.slug
  }
  assert.equal(head("shellBudgets.ca"), "a")
  assert.equal(head("ShellBudget.ca"), "a", "case and a plural fold away")
  assert.equal(head("shellBud.ca"), undefined, "a partial head names no thread — the menu stays closed")
  assert.equal(head("focusMode."), "b")
})

test("insertMention: a partly typed dotted token is replaced whole; a sentence's full stop is kept", () => {
  const address = "shellBudgets.cacheKeys"
  assert.deepEqual(insertMention("ask @shellBudgets.ca", 4, 20, address), { prose: "ask @shellBudgets.cacheKeys ", caret: 28 })
  // Caret mid-token, the rest of the dotted token after it replaced too.
  assert.deepEqual(insertMention("ask @shellBudgets.caXX about", 4, 20, address), { prose: "ask @shellBudgets.cacheKeys about", caret: 28 })
  assert.deepEqual(insertMention("ask @shell|Budgets.cacheKeys now".replace("|", ""), 4, 10, address), { prose: "ask @shellBudgets.cacheKeys now", caret: 28 })
  // A full stop right after the caret ends the sentence; it is not part of the token.
  assert.deepEqual(insertMention("ask @shellBud. Then", 4, 13, "shellBudgets"), { prose: "ask @shellBudgets . Then", caret: 18 })
  assert.deepEqual(insertMention("ask @shellBud.", 4, 13, "shellBudgets"), { prose: "ask @shellBudgets .", caret: 18 })
})

test("mentionSegments: a dotted mention links when its thread resolves, and carries its address", () => {
  const all = mentionCandidates(board)
  const text = "ask @shellBudgets.cacheKeys about @shellBudgets. Then @nobody.child and @focusMode.wave2.implW3."
  const segs = mentionSegments(text, all)
  assert.equal(segs.map((s) => s.text).join(""), text, "byte-for-byte")
  const mentions = segs.flatMap((s) => (s.kind === "mention" ? [[s.text, s.slug, s.address ?? null]] : []))
  assert.deepEqual(mentions, [
    ["@shellBudgets.cacheKeys", "a", "shellBudgets.cacheKeys"],
    ["@shellBudgets", "a", null],
    ["@focusMode.wave2.implW3", "b", "focusMode.wave2.implW3"],
  ], "a trailing full stop is never part of a mention; an unknown thread's child stays text")
  // A plain mention still carries its thread's status; a sub-agent's is the directory's to say.
  const plain = segs.find((s) => s.kind === "mention" && s.address === undefined)
  assert.equal(plain?.kind === "mention" && plain.status, "Tuning the cap")
})

test("resolveSubAgentMention / foldAddress: a mention finds its directory entry by the folded address", () => {
  assert.equal(foldAddress("@PortTheParser.CacheKeys"), "porttheparser.cachekey")
  assert.equal(resolveSubAgentMention(directory, "shellBudgets.cacheKeys")?.id, "t1")
  assert.equal(resolveSubAgentMention(directory, "ShellBudget.cache-key")?.id, "t1", "case, punctuation and a plural fold away per segment")
  assert.equal(resolveSubAgentMention(directory, "shellBudgets.wave2.implW3")?.id, "w1a")
  assert.equal(resolveSubAgentMention(directory, "shellBudgets.capAudit")?.id, "t3", "a returned child still resolves")
  assert.equal(resolveSubAgentMention(directory, "shellBudgets.implW3"), undefined, "an address skipping its Workflow names nothing")
  assert.equal(resolveSubAgentMention(directory, "shellBudgets.nothing"), undefined)
})

test("a thread's former names still resolve, after every current handle, and are never offered", () => {
  const renamed = thread({ id: "r", title: "Done reappears", titleAuto: false, formerTitles: ["Done persistence", "A sentence far too long to ever be a handle"] })
  const taken = thread({ id: "p", title: "Done persistence", titleAuto: false })
  const all = mentionCandidates([renamed])
  assert.deepEqual(all[0]?.formerHandles, [threadHandle("Done persistence")], "a sentence has no handle to keep")
  assert.equal(resolveMention(all, "donePersistence")?.slug, "r")
  assert.deepEqual(mentionSegments("Waiting on @donePersistence.doneRepro's reproduction", all).flatMap((s) => (s.kind === "mention" ? [[s.slug, s.address]] : [])), [["r", "donePersistence.doneRepro"]])
  assert.equal(resolveMention(mentionCandidates([renamed, taken]), "donePersistence")?.slug, "p", "a thread that holds the name now wins")
  assert.deepEqual(matchMentions(all, "persist"), [], "the typeahead offers current handles only")
  // Its sub-agents' addresses are rebuilt under the new name; the old address still finds the child.
  assert.equal(resolveSubAgentMention(directory, "anOldName.cacheKeys")?.id, "t1")
  assert.equal(resolveSubAgentMention(directory, "shellBudgets"), undefined, "a bare thread names no child")
})

test("crossProjectMentionCandidates: other projects' threads, tagged, minus the box's project and handles it has", () => {
  const queue = (projectSlug: string, threads: ThreadView[]) =>
    ({ projectId: projectSlug, projectSlug, projectName: `${projectSlug} name`, projectDir: "/", threads, doneCount: 0 }) as ProjectQueue
  const own = mentionCandidates(board)
  const queues = [
    queue("frizz", board),
    queue("nub", [thread({ id: "n1", title: "Shell budgets" }), thread({ id: "n2", title: "Parser port" })]),
    queue("app", [thread({ id: "p1", title: "Parser port" }), thread({ id: "p2", title: "Billing" })]),
  ]
  const cross = crossProjectMentionCandidates(queues, "frizz", own)
  assert.deepEqual(cross.map((c) => [c.handle, c.slug, c.project?.slug]), [
    ["parserPort", "n2", "nub"],
    ["billing", "p2", "app"],
  ], "a handle the box's project has, or an earlier project already offered, is not offered again")
  assert.equal(cross[0]!.project?.name, "nub name")
  const typed = matchMentions([...own, ...cross], "bil")
  assert.equal(typed[0]?.slug, "p2")
  assert.deepEqual(mentionSegments("ask @billing", [...own, ...cross]).at(-1), { kind: "mention", text: "@billing", slug: "p2", status: undefined, project: "app" })
})
