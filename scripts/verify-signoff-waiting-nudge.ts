// End-to-end check of the sign-off nudge's three readings of a fenceless rest, through REAL Claude
// workers on a real stack: the real tailer folds their transcripts, the real scheduler (SOURCE 9) picks
// the text, and the real wake path delivers it into the worker's own transcript.
//
//   shell  — the worker starts `sleep 900` in the background and rests bare: must receive the SHORT
//            variant, naming that shell by the id the runtime gave it, with the fence written out.
//   bare   — the worker rests bare with nothing running: must receive the LONG protocol (the control
//            that proves this harness can tell the two apart).
//   agent  — the worker dispatches a background sub-agent and rests bare: must receive NO nudge while
//            the child runs (a running child already parks the thread), the child must really be out for
//            several scheduler ticks (>= 30s, or the case proves nothing), and no nudge for that old rest
//            may land after the child returns and the worker signs off with ```done.
//   goal   — the agent case on a thread with a Goal armed at rest: must receive the SHORT variant naming
//            the child with an `agents:` fence (a child does not hold a Goal; only a fence does), and the
//            Goal must not fire on that rest.
//
// Boot a stack first (scheduler armed, real credentials, a throwaway project):
//   git init -q /tmp/nudge-e2e-proj && git -C /tmp/nudge-e2e-proj commit -q --allow-empty -m init
//   nub scripts/adhoc-stack.mjs --port=45613 --project=/tmp/nudge-e2e-proj --creds --wakers > /tmp/nudge-stack.log 2>&1 &
// then:
//   nub scripts/verify-signoff-waiting-nudge.ts 45613 [shell|bare|agent|goal ...]
// Every worker is a detached daemon that outlives the stack — kill them by the sandbox HOME afterwards.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { SIGNOFF_NUDGE_MARKER } from "../packages/shared/src/index.ts"

const [port = "45613", ...requested] = process.argv.slice(2)
const cases = requested.length ? requested : ["shell", "bare", "agent", "goal"]
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const board = await api.query("board")
const cwdSlug = String(board.projectDir).replace(/[^a-zA-Z0-9]/g, "-")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Rec = { type?: string; message?: { content?: unknown }; timestamp?: string; isSidechain?: boolean }
function records(sessionId: string): Rec[] {
  const p = join(homedir(), ".claude", "projects", cwdSlug, `${sessionId}.jsonl`)
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Rec] } catch { return [] } })
}
const blocks = (r: Rec): Array<Record<string, unknown>> => {
  const c = r.message?.content
  return typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : []
}
const textOf = (r: Rec) => blocks(r).flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n")
const nudgesIn = (recs: Rec[]) => recs.filter((r) => r.type === "user" && textOf(r).trimStart().startsWith(SIGNOFF_NUDGE_MARKER))

let failed = false
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failed = true }

const SLEEPER = "Run exactly this with the Bash tool, not in the background: python3 -c 'import time; time.sleep(75)'. Then reply DONE."
const NO_FENCE = "End that turn with only that word: no code fence, no code block, and no mcp__frizz__ tool call of any kind. Afterwards, follow whatever instructions arrive."
const PROMPTS: Record<string, string> = {
  shell: `This is a harness test. Use the Bash tool with run_in_background: true to run exactly \`sleep 900\`, then reply with the single word STARTED. ${NO_FENCE}`,
  bare: `This is a harness test. Reply with the single word HELLO and use no tools. ${NO_FENCE}`,
  // The child waits through python, not `sleep`: the Bash hook refuses a long foreground `sleep`, and a
  // refused child returns in ~5s, inside one scheduler tick, which made this case pass vacuously.
  agent: `This is a harness test. Use the Agent tool with run_in_background: true, subagent_type general-purpose, description "sleeper", prompt "${SLEEPER}" Then reply with the single word STARTED. ${NO_FENCE} When the sleeper's result arrives later, reply with the word RETURNED and end that message with a \`\`\`done fence whose body is one line.`,
  goal: `This is a harness test. Use the Agent tool with run_in_background: true, subagent_type general-purpose, description "sleeper", prompt "${SLEEPER}" Then reply with the single word STARTED. ${NO_FENCE}`,
}

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined): Promise<T | undefined> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = probe()
    if (v !== undefined) return v
    if (Date.now() > deadline) { console.log(`TIMEOUT waiting for ${what}`); return undefined }
    await sleep(2_000)
  }
}

for (const which of cases) {
  console.log(`\n== ${which} ==`)
  const { slug, sessionId } = await api.mutate("dispatch", { prompt: PROMPTS[which], backend: "claude", model: "sonnet", effort: "low" })
  console.log(`dispatched ${slug} (${sessionId})`)
  if (which === "goal") {
    // Armed before the worker's first rest (it takes several seconds to launch the child), the way an
    // operator arms one from the footer.
    await api.mutate("setOwnThreadRecurringPrompt", { slug, prompt: "Keep going until the sleeper has returned.", stopHook: true, heartbeat: false })
    console.log("Goal armed at rest")
  }
  // The worker's first rest: an assistant record that ended the turn with no tool call pending.
  const restAt = await waitFor("the worker's first rest", 240_000, () => {
    const r = records(sessionId).filter((x) => x.type === "assistant" && !x.isSidechain && /\b(STARTED|HELLO)\b/.test(textOf(x)))
    return r[0]?.timestamp
  })
  if (!restAt) { check(false, `${which}: the worker rested`); continue }
  console.log(`rested at ${restAt}`)

  if (which === "agent") {
    // The child waits 75s. Watch the parent's transcript through that window: no nudge may land while
    // the child is out. Early exit on the failure signal (a nudge), and on the child's return.
    const deadline = Date.now() + 150_000
    let nudged: Rec | undefined
    let returned = false
    while (Date.now() < deadline) {
      const recs = records(sessionId)
      nudged = nudgesIn(recs)[0]
      returned = recs.some((r) => r.type === "user" && /<task-notification>/.test(textOf(r)))
      if (nudged || returned) break
      await sleep(2_000)
    }
    const rested = Date.parse(restAt)
    const notifiedAt = records(sessionId).find((r) => r.type === "user" && /<task-notification>/.test(textOf(r)))?.timestamp
    const outFor = notifiedAt ? Math.round((Date.parse(notifiedAt) - rested) / 1000) : undefined
    console.log(`child returned: ${returned}; out for ${outFor ?? "?"}s after the rest`)
    check(!nudged, "agent: no sign-off nudge while the sub-agent was running")
    check(returned, "agent: the child's completion notification arrived")
    check(outFor !== undefined && outFor >= 30, "agent: the child was out for >= 30s (three scheduler ticks), so the window was really tested")
    // THE RETURN WINDOW: the child's notification is folded a beat before the record that wakes the parent,
    // and the old rest must not be nudged in it. The worker signs its reply off with ```done, which is
    // never nudged — so any nudge from here on is the misfire. A ~4% race (1/25 real returns): one run
    // passing is weak evidence; the deterministic pin is the real-tailer test in signoff-nudge.test.ts.
    if (returned && !nudged) {
      const reply = await waitFor("the worker's reply to the child", 120_000, () => {
        const after = records(sessionId).filter((x) => x.type === "assistant" && !x.isSidechain && /RETURNED/.test(textOf(x)))
        return after[0] ? textOf(after[0]) : undefined
      })
      if (reply && /```done/.test(reply)) {
        await sleep(20_000)
        check(nudgesIn(records(sessionId)).length === 0, "agent: no nudge for the old rest after the child returned and the worker signed off")
      } else {
        console.log("INCONCLUSIVE: the worker did not sign its reply off with ```done, so a later nudge could be for its new rest")
      }
    }
    continue
  }

  const nudge = await waitFor("the sign-off nudge", 180_000, () => nudgesIn(records(sessionId))[0])
  if (!nudge) { check(false, `${which}: a nudge was delivered`); continue }
  const msg = textOf(nudge)
  console.log(`nudge delivered ${Math.round((Date.parse(nudge.timestamp ?? "") - Date.parse(restAt)) / 1000)}s after the rest, ${msg.split("\n").length} lines:\n${msg.split("\n").map((l) => `  | ${l}`).join("\n")}`)

  if (which === "goal") {
    const ack = records(sessionId).flatMap(blocks).map((b) => JSON.stringify(b.content ?? "")).join("\n")
    const agentId = /agentId: ([A-Za-z0-9_-]+)/.exec(ack)?.[1]
    console.log(`runtime agent id: ${agentId}`)
    check(Boolean(agentId), "goal: the runtime gave the child an id")
    check(msg.includes(`- \`${agentId}\` — sub-agent: `), "goal: the nudge leads with that child by its id")
    check(msg.includes(`\`\`\`awaiting\nagents: [${agentId}]\nfor: 1h\n---`), "goal: and hands over its `agents:` fence, written out")
    check(!/DECIDE RATHER THAN ASK|STILL OWED/.test(msg), "goal: it is not the long protocol")
    // The Goal yields to the reminder on that rest, and the fence the worker answers with holds it until
    // the child returns: no Goal delivery may land while the child is out.
    const goalWhileOut = await waitFor("the child's return", 180_000, () => {
      const recs = records(sessionId)
      const back = recs.findIndex((r) => r.type === "user" && /<task-notification>/.test(textOf(r)))
      const upto = back < 0 ? recs : recs.slice(0, back)
      const goal = upto.find((r) => r.type === "user" && /\(Goal — sent each time you come to rest/.test(textOf(r)))
      if (goal) return { goal: true }
      return back >= 0 ? { goal: false } : undefined
    })
    check(goalWhileOut?.goal === false, "goal: the Goal did not fire on a rest behind the child")
    continue
  }

  if (which === "shell") {
    // The id the runtime showed the worker, read off its own transcript.
    const ack = records(sessionId).flatMap(blocks).map((b) => JSON.stringify(b.content ?? "")).join("\n")
    const taskId = /running in background with ID: ([A-Za-z0-9_-]+)/.exec(ack)?.[1]
    console.log(`runtime shell id: ${taskId}`)
    check(Boolean(taskId), "shell: the runtime gave the shell an id")
    check(msg.includes(`- \`${taskId}\` — `), "shell: the nudge leads with that shell by its id")
    check(msg.includes(`\`\`\`awaiting\nshells: [${taskId}]\nfor: 1h\n---`), "shell: and hands over its fence, written out")
    check(!/DECIDE RATHER THAN ASK|STILL OWED/.test(msg), "shell: it is not the long protocol")
    // The worker's answer — informational: what the short variant cost, and whether the fence it wrote parks.
    const reply = await waitFor("the worker's answer", 120_000, () => {
      const after = records(sessionId).filter((x) => x.type === "assistant" && !x.isSidechain && Date.parse(x.timestamp ?? "") > Date.parse(nudge.timestamp ?? ""))
      const t = after.map(textOf).join("\n")
      return /```(awaiting|done)/.test(t) ? { t, at: after.at(-1)?.timestamp } : undefined
    })
    if (reply) console.log(`worker answered ${Math.round((Date.parse(reply.at ?? "") - Date.parse(nudge.timestamp ?? "")) / 1000)}s later:\n${reply.t.split("\n").map((l) => `  > ${l}`).join("\n")}`)
    if (reply) {
      await sleep(4_000)
      const t = (await api.query("board")).threads?.find((x: { id?: string }) => x.id === slug)
      console.log(`board after the answer: awaitingBackground=${t?.awaitingBackground} needsYou=${t?.needsYou}`)
    }
  } else {
    check(/DECIDE RATHER THAN ASK/.test(msg) && /THE FENCE IS NOT WHAT YOU OWE/.test(msg), "bare: the long protocol")
    check(!/shells: \[[^<]/.test(msg), "bare: no shell fence pre-filled")
  }
}
if (failed) process.exitCode = 1
