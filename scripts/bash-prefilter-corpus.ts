// Build the corpus that checks cc-worker/hooks/bash-background.sh against the node hook it fronts.
//
// Reads every Bash `tool_use` out of Claude transcripts (threads and their sub-agent sidechains), keeping
// what a PreToolUse stdin needs: tool_input keys in the order Claude sends them (command, timeout,
// description, run_in_background, then anything else — captured from a live `claude -p` run on 2.1.285
// with a hook that tee'd its stdin), the cwd, and whether the call came from a sub-agent.
//
//   nub scripts/bash-prefilter-corpus.ts --out <file.jsonl>                     every distinct input
//   nub scripts/bash-prefilter-corpus.ts --fixture <file.jsonl> [--only <re>]   the checked-in sample
//   nub scripts/bash-prefilter-corpus.ts --fixture <file.jsonl> --from <in.jsonl>   re-sample a corpus file
//
// Each output line is `{"cwd", "subAgent", "tool_input"}`: everything that varies per call. The test
// wraps it in the envelope (hookStdin) to get the exact bytes Claude writes. The full corpus is a
// one-off (it is the maintainer's private history); the fixture is a bounded, secret-screened,
// STRATIFIED sample (pickFixture) restricted by default to this repo's own transcripts, and is what
// packages/server/src/bash-background-prefilter.test.ts replays on every run. `--from` reads entries
// from an existing corpus or fixture file instead of the transcripts — how the 2026-10-06 fixture was
// cut from the 2026-10-02 one without letting any new history into the repo.
import { execFileSync } from "node:child_process"
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { bashHookResponse } from "../cc-worker/hooks/bash-background.mjs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const out = flag("--out")
const fixture = flag("--fixture")
const from = flag("--from")
const only = new RegExp(flag("--only") ?? (fixture ? "^-home-ssalb-frizz" : "."))
const root = flag("--root") ?? join(homedir(), ".claude", "projects")
if (!out && !fixture) throw new Error("usage: bash-prefilter-corpus.ts --out <file> | --fixture <file> [--only <re>] [--root <dir>]")

function* transcripts(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* transcripts(path)
    else if (entry.name.endsWith(".jsonl")) yield path
  }
}

const KEY_ORDER = ["command", "timeout", "description", "run_in_background"]
function orderedToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER) if (key in input) ordered[key] = input[key]
  for (const [key, value] of Object.entries(input)) if (!(key in ordered)) ordered[key] = value
  return ordered
}

// What the test needs to rebuild a hook stdin; the envelope around it is fixed (the test's hookStdin).
type Entry = { cwd: string; subAgent: boolean; tool_input: Record<string, unknown> }
const seen = new Set<string>()
const entries: Entry[] = []
let files = 0
let toolUses = 0

if (from) {
  for (const line of readFileSync(from, "utf8").split("\n")) if (line) entries.push(JSON.parse(line) as Entry)
}
for (const project of from ? [] : readdirSync(root)) {
  if (!only.test(project)) continue
  const projectDir = join(root, project)
  // Other sessions create and delete throwaway projects while this runs; a vanished one is skipped.
  const isDir = (() => { try { return statSync(projectDir).isDirectory() } catch { return false } })()
  if (!isDir) continue
  for (const file of (() => { try { return [...transcripts(projectDir)] } catch { return [] } })()) {
    files++
    const stream = createReadStream(file, "utf8")
    stream.on("error", () => {})
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.includes('"name":"Bash"')) continue
      let record: any
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      for (const block of record?.message?.content ?? []) {
        if (block?.type !== "tool_use" || block.name !== "Bash" || !block.input || typeof block.input !== "object") continue
        toolUses++
        const entry: Entry = { cwd: String(record.cwd ?? "/"), subAgent: Boolean(record.isSidechain && record.agentId), tool_input: orderedToolInput(block.input) }
        const key = JSON.stringify(entry)
        if (seen.has(key)) continue
        seen.add(key)
        entries.push(entry)
      }
    }
  }
}
console.error(`${files} transcripts, ${toolUses} Bash calls, ${entries.length} distinct inputs`)

const line = (e: Entry) => JSON.stringify(e)
if (out) writeFileSync(out, entries.map(line).join("\n") + "\n")

// The fixture is checked in, so it carries no one's identity: the home directory (in every cwd, and
// spelled `-home-<user>` in ~/.claude/projects paths), the git author name, and every email address
// are replaced. In the decoded strings, never the JSON text: there an email right after a `\n` escape
// would swallow its `n` and leave a `\u`. None of them can change a decision, since the pre-filter
// reads only `&`, `worktree`, `\u` and the key names (the test re-proves the property on the result
// anyway). A draft of the fixture made without this held the maintainer's commit email.
const identity = (() => {
  const home = homedir()
  const user = userInfo().username
  let author = ""
  try {
    author = execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim()
  } catch {}
  return (text: string) => {
    let clean = text.split(home).join("/home/u").split(`-home-${user}`).join("-home-u")
    if (author) clean = clean.split(author).join("A U Thor")
    return clean.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com")
  }
})()
const scrub = (value: unknown): unknown =>
  typeof value === "string" ? identity(value)
  : Array.isArray(value) ? value.map(scrub)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [identity(k), scrub(v)]))
  : value

if (fixture) {
  // Never check in anything that looks like a credential, and keep the file reviewable.
  const SECRET = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9-]{20,}|xox[abpr]-|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN|(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S{8,}|[A-Za-z0-9]{40,}/i
  const eligible = entries.filter((e) => {
    const text = JSON.stringify(e.tool_input)
    return text.length <= 2048 && !SECRET.test(text)
  })
  // Deterministic shuffle (a fixed LCG), so re-running on the same history yields the same sample.
  let seed = 0x2f6b
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const shuffled = eligible.map((e) => [rand(), e] as const).sort((a, b) => a[0] - b[0]).map(([, e]) => e)
  const picked = pickFixture(shuffled)
  writeFileSync(fixture, picked.map((e) => line(scrub(e) as Entry)).join("\n") + "\n")
  console.error(`fixture: ${picked.length} of ${eligible.length} eligible (${entries.length - eligible.length} over 2KB or secret-shaped)`)
}

// A STRATIFIED SAMPLE of ~100, not a random 1,000 (2026-10-06). The random draw (700 inputs that held a
// trigger, 300 that did not) made the test replay 1,000 real calls on every run to reach the 22 that node
// acts on; the branches are what the sample is for, so it is cut by them instead. Each stratum keeps the
// first few of the shuffled entries in it:
//   - every input node ACTS on (a denial or advice), up to ACTED per answer, worker and sub-agent apart:
//     the real calls each skip check exists to send to node;
//   - inputs node answers `{}` but that hold a trigger the pre-filter must still hand off on (a `\u`
//     escape, the word `worktree`, a bare `&`, a `run_in_background` or `timeout` key), up to HANDED per
//     trigger and side: the pre-filter's conservative hand-offs on real text;
//   - PLAIN inputs with none of those, per side: the calls the pre-filter exists to answer itself.
// The labels below only sort entries into strata; the test, not this, decides what is right.
function pickFixture(shuffled: Entry[]): Entry[] {
  const ACTED = 10
  const HANDED = 3
  const PLAIN = 25
  const worker = { FRIZZ_THREAD: "thread-under-test" }
  const answer = (e: Entry) => {
    const stdin = JSON.stringify({ cwd: e.cwd, ...(e.subAgent ? { agent_id: "a1" } : {}), tool_input: e.tool_input })
    const out = JSON.stringify(bashHookResponse(stdin, ["node", "bash-background.mjs"], worker))
    if (out === "{}") return undefined
    if (/"permissionDecision":"deny"/.test(out)) return /worktree/i.test(out) ? "deny worktree" : "deny job"
    return e.tool_input.run_in_background === true ? "advice background" : "advice timeout"
  }
  const trigger = (e: Entry) => {
    const text = JSON.stringify(e)
    const command = typeof e.tool_input.command === "string" ? e.tool_input.command : ""
    if (/\\u/.test(text)) return "unicode-escape"
    if (/worktree(?![A-Za-z0-9_])/.test(command)) return "worktree"
    if (/(?:^|[^&<>])&(?![&>])/.test(command)) return "ampersand"
    if ("run_in_background" in e.tool_input) return "background"
    if ("timeout" in e.tool_input) return "timeout"
    return undefined
  }
  const taken = new Map<string, number>()
  const picked: Entry[] = []
  for (const e of shuffled) {
    const acted = answer(e)
    const handed = acted ? undefined : trigger(e)
    const [stratum, cap] = acted ? [`acted ${acted}`, ACTED] : handed ? [`handed ${handed}`, HANDED] : ["plain", PLAIN]
    const key = `${stratum} ${e.subAgent ? "sub-agent" : "worker"}`
    if ((taken.get(key) ?? 0) >= cap) continue
    taken.set(key, (taken.get(key) ?? 0) + 1)
    picked.push(e)
  }
  console.error([...taken].sort().map(([k, n]) => `  ${k}: ${n}`).join("\n"))
  return picked
}
