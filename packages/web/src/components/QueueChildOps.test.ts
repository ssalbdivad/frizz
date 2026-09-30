import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Api } from "../api/rpc.ts"
import { QueueChildOps } from "./QueueChildOps.tsx"

const thread = {
  id: "parent",
  subAgents: [
    { id: "toolu_a", taskId: "a93a2fe4400f31533", label: "Verify goal caps on a real stack", startedAt: "2026-09-29T18:10:00.000Z", state: "running" as const, stoppable: true },
    { id: "toolu_wf", label: "verify-wave", startedAt: "2026-09-29T18:12:00.000Z", state: "running" as const, workflow: true },
    { id: "aVerify1", label: "verify:S8:0.1", startedAt: "2026-09-29T18:13:00.000Z", state: "running" as const, depth: 2, parentId: "toolu_wf", phase: "Review" },
    { id: "toolu_q", label: "Quiet one", startedAt: "2026-09-29T17:00:00.000Z", state: "stale" as const },
  ],
  bgShells: [{ id: "toolu_sh", label: "nub run dev", startedAt: "2026-09-29T17:30:00.000Z", state: "running" as const }],
}
const render = (props: Partial<Parameters<typeof QueueChildOps>[0]> = {}) =>
  renderToStaticMarkup(createElement(QueueChildOps, { project: { slug: "frizz" }, thread, api: {} as Api, onOpenThread: () => {}, ...props }))

test("the card's ops column lists every sub-agent, Workflow and shell, in the drawer's row shape", () => {
  const html = render()
  assert.match(html, /data-queue-ops="parent"/)
  // Agents first (dispatch order, a workflow's agents under it), then shells — the drawer strip's order.
  const order = ["Verify goal caps on a real stack", "verify-wave", "verify:S8:0.1", "Quiet one", "nub run dev"].map((label) => html.indexOf(label))
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), `order ${order}`)
  // The drawer's "sheet" density: kind tags, the live dots, and the stale child still listed.
  for (const tag of [">AGENT<", ">FLOW<", ">SHELL<"]) assert.ok(html.includes(tag), tag)
  assert.match(html, /stale — no recent output/)
  assert.match(html, /Review › verify:S8:0\.1/, "a workflow agent's phase rides its tooltip")
})

test("while the awaiting card lists the children, only the shells are left here; nothing live ⇒ nothing drawn", () => {
  const html = render({ agents: false })
  assert.doesNotMatch(html, /Verify goal caps/)
  assert.match(html, /nub run dev/)
  assert.equal(render({ thread: { id: "idle", subAgents: [], bgShells: [] } }), "")
})

// On the queue card the shells are the TERM strip's (ThreadTerminals ThreadProcessStrip), handed in as
// `after` so it hangs in this column under the AGENT / FLOW rows — and this column's SHELL rows are off,
// so a shell is drawn once.
test("with its shells handed to the card's strip, the column draws the agents and then that strip, once", () => {
  const strip = createElement("div", { "data-strip": "" }, "TERM rows")
  const html = render({ shells: false, after: strip })
  assert.doesNotMatch(html, />SHELL</)
  assert.doesNotMatch(html, /nub run dev/)
  assert.ok(html.indexOf("Quiet one") < html.indexOf("data-strip"), "the strip hangs under the agent rows")
  assert.match(render({ agents: false, shells: false, after: strip }), /^<div class="-mt-3 shrink-0 px-5 pb-3" data-queue-ops="parent">[\s\S]*data-strip/, "the strip alone still gets the column")
  assert.equal(render({ agents: false, shells: false, after: null }), "", "nothing to draw ⇒ no empty inset")
})
