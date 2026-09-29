import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"

// The rail's badges: each open project's queue and Active band. Handlers are lazy, so the stub carries only what `createRouter` resolves up
// front plus this procedure's one dependency: `activeTenants`, the server's view of which projects are
// open in this process and their boards.
function harness(activeTenants: AppContext["activeTenants"], own?: { project: Project; board: BoardManager }) {
  const ctx = {
    project: own?.project ?? { dir: tmpdir(), stateDir: tmpdir(), id: "own" },
    storage: {},
    board: own?.board ?? {},
    tailer: {},
    activeTenants,
  } as unknown as AppContext
  return createRouter(ctx)
}

const project = (id: string): Project => ({ id, dir: tmpdir(), stateDir: tmpdir(), name: id, label: id, cwdSlug: id })
const board = (threads: Partial<ThreadView>[]): BoardManager =>
  ({ snapshot: async () => ({ threads }) as unknown as BoardSnapshot }) as unknown as BoardManager
const session = (needsYou: boolean, extra: Partial<ThreadView> = {}): Partial<ThreadView> =>
  ({ kind: "session", state: "open", needsYou, ...extra })

test("counts the queue of every open project, keyed by id, and leaves out one that will not answer", async () => {
  const router = harness(() => [
    { project: project("a"), board: board([session(true), session(true), session(false, { runtime: "running" })]) },
    // Archived, foreign and legacy rows never queue, whatever `needsYou` says — the same predicate the
    // web's sidebar bands on (groups.ts `queued`), so the badge and the rail cannot disagree.
    { project: project("b"), board: board([session(true, { state: "archived" }), session(true, { foreign: true }), { kind: "legacy", needsYou: true }, session(true)]) },
    { project: project("c"), board: board([]) },
    // A board mid-deactivation throws from snapshot(); that project has no count this round, and the
    // others still do.
    { project: project("d"), board: { snapshot: async () => { throw new Error("board stopped") } } as unknown as BoardManager },
  ])
  assert.deepEqual(await router.projectsRailCounts.handler({ input: undefined }), {
    a: { queued: 2, running: 1 },
    b: { queued: 1, running: 0 },
    c: { queued: 0, running: 0 },
  })
})

test("counts the Active band as running — the rows the sidebar spins below the rule, and nothing else", async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const router = harness(() => [
    {
      project: project("p"),
      board: board([
        session(false, { runtime: "running" }), // mid-turn
        session(false, { runtime: "spawning" }), // starting
        session(false, { runtime: "turn-idle", subAgents: [{ state: "running" }] } as Partial<ThreadView>), // resting on its own sub-agent
        // Not Active: queued (the badge's other half, even with a live child), snoozed by the operator,
        // parked behind an awaiting fence the server honoured, archived, and a terminal the human owns.
        session(true, { runtime: "turn-idle", subAgents: [{ state: "running" }] } as Partial<ThreadView>),
        session(false, { runtime: "turn-idle", snoozedUntil: future }),
        session(false, { runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } }),
        session(false, { runtime: "exited", state: "archived" }),
        session(false, { runtime: "running", foreign: true }),
      ]),
    },
  ])
  assert.deepEqual(await router.projectsRailCounts.handler({ input: undefined }), { p: { queued: 1, running: 3 } })
})

test("without a tenant map (a test context, a one-project server) it answers for its own project alone", async () => {
  const router = harness(undefined, { project: project("solo"), board: board([session(true), session(false, { runtime: "running" })]) })
  assert.deepEqual(await router.projectsRailCounts.handler({ input: undefined }), { solo: { queued: 1, running: 1 } })
})

test("a Done row whose session is still running counts as running, and a Done row at rest does not", async () => {
  // Before 2026-09-24 this rode in through sectionOf, which lifted the row into Active. The row stays in
  // Done now (only the human reopens it) but it wears a spinner there, and the badge's spinner says
  // "this project has work in flight" — which a draining turn is (shared doneButRunning).
  const router = harness(() => [
    {
      project: project("p"),
      board: board([
        session(false, { state: "archived", runtime: "running" }),
        session(false, { state: "archived", runtime: "turn-idle", subAgents: [{ state: "running" }] } as Partial<ThreadView>),
        // Negative controls: at rest, exited, and a foreign terminal.
        session(false, { state: "archived", runtime: "turn-idle" }),
        session(false, { state: "archived", runtime: "exited" }),
        session(false, { state: "archived", runtime: "running", foreign: true }),
      ]),
    },
  ])
  assert.deepEqual(await router.projectsRailCounts.handler({ input: undefined }), { p: { queued: 0, running: 2 } })
})
