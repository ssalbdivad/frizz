import { test } from "node:test"
import assert from "node:assert/strict"
import type { ComposerContextItem } from "./composerContext.ts"
import { draftKey } from "./drafts.ts"
import {
  addContextItem,
  parseStagedContext,
  restoreContextItems,
  serializeStagedContext,
  stagedContext,
  stagedItems,
  takeContextItems,
} from "./stagedContext.ts"

const item = (token: string, over: Partial<ComposerContextItem> = {}): ComposerContextItem =>
  ({ id: 1, token, path: "/repo/src/a.ts", text: "const a = 1", startLine: 12, endLine: 20, ...over })

// A RELOAD keeps the draft (sessionStorage) and must keep what its tokens stand for, or the send carries
// `@a.ts:12-20` with no definition behind it.
test("staged items survive the round trip through sessionStorage", () => {
  const key = draftKey.dispatch("/repo")
  const staged = { [key]: [item("@a.ts:12-20"), item("@b.ts:3", { id: 2, path: "/repo/b.ts", startLine: 3, endLine: 3 })] }
  const drafts: Record<string, string> = { [key]: "look at @a.ts:12-20 and @b.ts:3" }
  assert.deepEqual(parseStagedContext(serializeStagedContext(staged, () => 1), (k) => drafts[k] ?? ""), staged)
})

test("only items whose token is still in their draft come back", () => {
  const kept = draftKey.followUp("/repo", "fix-auth", "s1")
  const sent = draftKey.followUp("/repo", "fix-auth", "s0")
  const raw = serializeStagedContext({
    [kept]: [item("@a.ts:12-20"), item("@a.ts:12-20#2", { id: 2 })],
    [sent]: [item("@a.ts:12-20", { id: 3 })],
  }, () => 1)
  // The second item's token was deleted from the prose; the other draft was sent (and so cleared).
  const drafts: Record<string, string> = { [kept]: "see @a.ts:12-20" }
  assert.deepEqual(parseStagedContext(raw, (k) => drafts[k] ?? ""), { [kept]: [item("@a.ts:12-20")] })
  // A token that is only the PREFIX of what the prose holds is not the token (composerContext hasToken).
  assert.deepEqual(parseStagedContext(raw, () => "see @a.ts:12-200"), {})
})

test("a damaged snapshot reads as nothing staged, and never throws", () => {
  const key = draftKey.dispatch("/repo")
  const draft = () => "@a.ts:12-20"
  for (const raw of [null, "", "{", "[]", "42", JSON.stringify({ [key]: "nope" })]) assert.deepEqual(parseStagedContext(raw, draft), {}, String(raw))
  // A malformed item is dropped; its well-formed neighbour stays.
  const raw = JSON.stringify({ [key]: [{ token: "@a.ts:12-20" }, item("@a.ts:12-20"), { ...item("@a.ts:12-20"), startLine: "12" }] })
  assert.deepEqual(parseStagedContext(raw, draft), { [key]: [item("@a.ts:12-20")] })
})

test("the snapshot is bounded: a draft whose quotes would overflow it is left out whole", () => {
  const small = draftKey.dispatch("/small")
  const huge = draftKey.dispatch("/huge")
  const raw = serializeStagedContext({ [small]: [item("@a.ts:1")], [huge]: [item("@b.ts:1", { text: "x".repeat(2 * 1024 * 1024) })] }, () => 1)
  assert.ok(raw.length < 1024 * 1024)
  assert.deepEqual(Object.keys(JSON.parse(raw) as object), [small])
})

// Past the cap the OLDEST drafts go, as the drafts' own bound does — never the selection just sent to the
// box in front of the human, which is the one appended last (review C10).
test("past the cap the snapshot keeps the newest drafts, whatever order they were staged in", () => {
  const quote = "q".repeat(64 * 1024)
  const staged: Record<string, ComposerContextItem[]> = {}
  const touched: Record<string, number> = {}
  for (let i = 0; i < 16; i++) {
    const key = draftKey.followUp("/repo", `old-${i}`, "s1")
    staged[key] = [item("@a.ts:12-20", { text: quote })]
    touched[key] = 1_000 + i
  }
  const fresh = draftKey.dispatch("/repo")
  staged[fresh] = [item("@b.ts:3", { text: quote })]
  touched[fresh] = 9_000
  const raw = serializeStagedContext(staged, (key) => touched[key])
  assert.ok(raw.length <= 1024 * 1024)
  const keys = Object.keys(JSON.parse(raw) as object)
  assert.ok(keys.includes(fresh), "the newest draft's quote is kept")
  // What did not fit is the oldest: every key kept is newer than every key dropped.
  const dropped = Object.keys(staged).filter((key) => !keys.includes(key))
  assert.ok(dropped.length > 0, "the fixture really does overflow the cap")
  assert.ok(Math.min(...keys.map((key) => touched[key]!)) > Math.max(...dropped.map((key) => touched[key]!)))
})

test("a key whose draft is gone is not written at all", () => {
  const live = draftKey.dispatch("/repo")
  const gone = draftKey.followUp("/repo", "sent", "s1")
  const raw = serializeStagedContext({ [gone]: [item("@a.ts:1")], [live]: [item("@b.ts:2")] }, (key) => (key === live ? 5 : undefined))
  assert.deepEqual(Object.keys(JSON.parse(raw) as object), [live])
})

// Keyed by DRAFT, so two projects' identically named threads — slugs are unique only within a project —
// and two sessions of one thread each keep their own roster.
test("staging is per draft: same slug in two projects, or two sessions, never share items", () => {
  const a = draftKey.followUp("/work/a", "fix-auth", "s1")
  const b = draftKey.followUp("/work/b", "fix-auth", "s1")
  addContextItem(a, { token: "@x.ts:1", path: "/work/a/x.ts", text: "a" })
  addContextItem(b, { token: "@x.ts:1", path: "/work/b/x.ts", text: "b" })
  assert.deepEqual(stagedItems(a).map((i) => i.path), ["/work/a/x.ts"])
  assert.deepEqual(stagedItems(b).map((i) => i.path), ["/work/b/x.ts"])
  const taken = takeContextItems(a)
  assert.deepEqual(taken.map((i) => i.text), ["a"])
  assert.equal(stagedContext[a], undefined)
  assert.deepEqual(stagedItems(b).map((i) => i.text), ["b"])
  // A rejected send puts its items back AHEAD of anything staged while it was in flight.
  addContextItem(a, { token: "@y.ts:2", path: "/work/a/y.ts", text: "later" })
  restoreContextItems(a, taken)
  assert.deepEqual(stagedItems(a).map((i) => i.text), ["a", "later"])
  // Ids stay unique across keys, so a React key built from one never collides.
  const ids = [...stagedItems(a), ...stagedItems(b)].map((i) => i.id)
  assert.equal(new Set(ids).size, ids.length)
  takeContextItems(a)
  takeContextItems(b)
})
