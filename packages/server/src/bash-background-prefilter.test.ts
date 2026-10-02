// cc-worker/hooks/bash-background.sh answers `{}` for a Bash call without starting node, and is only
// allowed to where node would answer `{}` too. These tests hold it to that, against node itself:
//
// - THE PROPERTY, on real inputs: every Bash call in the checked-in corpus sample (real worker and
//   sub-agent calls from this repo's own transcripts, rebuilt as the exact stdin Claude writes — see
//   scripts/bash-prefilter-corpus.ts) that the pre-filter answers itself is one node answers `{}`.
//   Point BASH_PREFILTER_CORPUS at a full corpus built by that script to run the same check over all
//   of it.
// - The same property on adversarial inputs aimed at each check, every node test's command, and
//   every shell this can meet (dash, bash, bash --posix, busybox ash).
// - A mutant of the pre-filter with any one check removed FAILS the property on these inputs, so the
//   inputs are strong enough to catch the bug each check exists for (the negative control).
// - Fail-open: a syntax or fatal runtime error in the pre-filter, or the file or `sh` missing, still
//   lands in node.
// - The hooks.json command itself, through /bin/sh -c with the REAL node, as Claude Code runs it.
//
// These skip on win32 because the harness itself is POSIX (a `#!/bin/sh` fake node, `/bin/sh -c`). On
// Windows Claude Code runs the hook through Git Bash, whose `sh` runs this file unchanged; that was
// checked once on a real Windows host (see bash-background.sh § WINDOWS), not here.
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { bashHookResponse } from "../../../cc-worker/hooks/bash-background.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const hooks = join(here, "../../../cc-worker/hooks")
const PREFILTER = join(hooks, "bash-background.sh")
const NODE_HOOK = join(hooks, "bash-background.mjs")
const WORKER = { FRIZZ_THREAD: "thread-under-test" }
const skip = process.platform === "win32" ? "POSIX sh pre-filter" : false

type Entry = { cwd: string; subAgent: boolean; tool_input: unknown }

/** The exact stdin Claude Code 2.1.285 writes to a PreToolUse(Bash) hook (captured live), for an entry. */
function hookStdin(entry: Entry): string {
  const session = "d16df0f0-861b-4259-aad6-8e86c6984aba"
  return JSON.stringify({
    session_id: session,
    transcript_path: `/home/u/.claude/projects/${entry.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${session}.jsonl`,
    cwd: entry.cwd,
    prompt_id: "700b52df-adde-40db-a539-04589c005e40",
    permission_mode: "bypassPermissions",
    ...(entry.subAgent ? { agent_id: "a13698092bf1316dd", agent_type: "general-purpose" } : {}),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: entry.tool_input,
    tool_use_id: "toolu_01G7oP23QX5xd3wLds76p57n",
  }) + "\n"
}

const call = (tool_input: unknown, cwd = "/home/u/project", subAgent = false) => hookStdin({ cwd, subAgent, tool_input })

function loadCorpus(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => hookStdin(JSON.parse(line)))
}

// A `node` that reports it was reached and echoes the stdin it got, so a run says which way the
// pre-filter went and proves the hand-off carried the identical bytes.
const HANDED_OFF = "HANDED-OFF:"
const temps: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const fakeBin = tempDir("frizz-prefilter-node-")
writeFileSync(join(fakeBin, "node"), `#!/bin/sh\nprintf '%s' '${HANDED_OFF}'\ncat\n`)
chmodSync(join(fakeBin, "node"), 0o755)

type Run = { stdout: string; stderr: string; status: number | null }
function runPrefilter(stdin: string, opts: { env?: Record<string, string>; shell?: string[]; script?: string; args?: string[] } = {}): Promise<Run> {
  const [cmd, ...shellArgs] = opts.shell ?? ["sh"]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...shellArgs, opts.script ?? PREFILTER, ...(opts.args ?? [])], {
      env: { PATH: `${fakeBin}${delimiter}${process.env.PATH}`, ...(opts.env ?? WORKER) },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d))
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (status) => resolve({ stdout, stderr, status }))
    child.stdin.on("error", () => {})
    child.stdin.end(stdin)
  })
}

const nodeAnswer = (stdin: string, env: Record<string, string> = WORKER) => JSON.stringify(bashHookResponse(stdin, ["node", NODE_HOOK], env))

type Verdict = { skipped: number; handedOff: number; neededNode: number; violations: string[] }
async function check(stdins: string[], opts: Parameters<typeof runPrefilter>[1] = {}, concurrency = 12): Promise<Verdict> {
  const verdict: Verdict = { skipped: 0, handedOff: 0, neededNode: 0, violations: [] }
  let next = 0
  const worker = async () => {
    while (next < stdins.length) {
      const stdin = stdins[next++]
      const run = await runPrefilter(stdin, opts)
      const answer = nodeAnswer(stdin, opts.env ?? WORKER)
      if (answer !== "{}") verdict.neededNode++
      if (run.status !== 0) verdict.violations.push(`exit ${run.status} (${run.stderr.trim()}): ${stdin}`)
      else if (run.stdout.startsWith(HANDED_OFF)) {
        verdict.handedOff++
        if (run.stdout.slice(HANDED_OFF.length) !== stdin) verdict.violations.push(`hand-off altered stdin: ${stdin}`)
      } else {
        verdict.skipped++
        if (run.stdout !== "{}") verdict.violations.push(`skip printed ${JSON.stringify(run.stdout)}: ${stdin}`)
        else if (answer !== "{}") verdict.violations.push(`SKIPPED A CALL NODE ACTS ON (${answer.slice(0, 120)}): ${stdin}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return verdict
}

// Inputs aimed at each check. Every command node's own tests deny or advise on is here too.
const NODE_TEST_COMMANDS = [
  "cargo test > /tmp/test.log 2>&1 &",
  "(nub scripts/remote-build.ts --job test > /tmp/f3.log 2>&1) &\nsleep 2; echo build started",
  "nohup nub scripts/ci-watch.ts --pr 587 > /tmp/ci.log 2>&1 & echo watcher started",
  "first & second & echo both-started",
  "server & disown",
  "server & exit 0",
  "server & exec echo done",
  "(server &)",
  "server & pid=$!; kill $pid",
  `bash -c "nub scripts/ci-watch.ts > /tmp/ci.log 2>&1 &"`,
  "sh -c 'server &'",
  "zsh -lc 'server & echo started'",
  "/bin/sh -c 'server &'",
  "cd /tmp && bash -c 'server &'",
  `bash -c "sh -c 'server &'"`,
  "docker run --rm -w /src rust:1-bookworm bash -c 'cargo build &'",
  "a & b & wait",
  "server & pid=$!; trap 'kill $pid' EXIT; curl localhost:3000",
  "printf '%s\\n' '&'",
  'echo "&"',
  `echo "--- decode: $(python3 -c 'v=851968;print(f"{v>>16}.{(v>>8)&255}.{v&255}")')"`,
  "echo one && echo two",
  "tool 2>&1 | tail -1",
  "ssh host 'nohup remote-job > /tmp/job.log 2>&1 &'",
  "cat > probe.sh <<'EOF'\nserver &\necho $!\nEOF",
  "trap 'kill $pid' INT; server & pid=$!; curl -s localhost",
  "git worktree add ../yes-perf -b perf",
  "git -C /r worktree add /abs/t",
  "cd /r && git -c core.x=1 worktree add -B b --reason why /abs/t",
  "git worktree list; echo worktree add x",
  "cargo test &",
  "cargo test & disown",
  "limactl shell landlock-vm bash -lc 'df -h / | tail -1 &'",
  "ssh host bash -lc 'remote-job &'",
  "ssh host 'bash -c \"remote-job &\"'",
  "bash -c 'a & b & wait'",
  "bash -c 'cd /tmp && for s in $(cat specs); do npm pack \"$s\"; done; echo DONE'",
  "echo 'bash -c \"server &\"' > note.txt",
  "server & pid=$!; curl localhost:3000; kill $pid; wait $pid",
  "trap 'kill $pid 2>/dev/null; wait' EXIT; PORT=0 pnpm start > /tmp/start.log 2>&1 & pid=$!; for i in 1 2 3; do grep -q http /tmp/start.log && break; sleep 1; done; curl -s localhost",
  "trap 'kill $pid' 0; server & pid=$!; curl -s localhost",
  "PORT=0 pnpm start > /tmp/start.log 2>&1 & pid=$!; for i in 1 2 3; do grep -q http /tmp/start.log && break; sleep 1; done; curl -s localhost",
]
const BS = "\\"
const ADVERSARIAL: string[] = [
  ...NODE_TEST_COMMANDS.map((command) => call({ command })),
  ...NODE_TEST_COMMANDS.map((command) => call({ command }, "/home/u/p", true)),
  // `&` against every neighbour, including the backslash node's own scan accepts but `bash -c "…"`
  // un-escaping undoes.
  ...["a &", "&", "& a", "a&b", "a &&& b", "x >&2", "x <&3", "x &>/dev/null", "x &>> log", "x |& y", "x ;& y", "a &\nb",
    `a ${BS}& b`, `bash -c "job ${BS}&"`, `bash -c "a ${BS}&& b"`, `bash -c "x 2>${BS}&1"`, `sh -c "sh -c ${BS}"job ${BS}${BS}${BS}&${BS}""`,
    "x 2>&1&", "x 2>&1 &", "x &&& y", "x &>&2", "a &| b"].map((command) => call({ command })),
  // Background and timeout, every spelling.
  call({ command: "npx vite", run_in_background: true }),
  call({ command: "npx vite", run_in_background: true, timeout: 600000 }),
  call({ command: "npx vite", run_in_background: true, timeout: 0 }),
  call({ command: "npx vite", run_in_background: false }),
  call({ command: "npx vite", run_in_background: false, timeout: 3600000 }),
  call({ command: "npx vite", run_in_background: "true" }),
  call({ command: "npx vite", run_in_background: 1 }),
  call({ command: "pnpm prChecks", timeout: 3600000 }),
  call({ command: "pnpm prChecks", timeout: 900000 }),
  call({ command: "pnpm prChecks", timeout: 900001 }),
  call({ command: "pnpm prChecks", timeout: 999999 }),
  call({ command: "pnpm prChecks", timeout: 1000000 }),
  call({ command: "pnpm prChecks", timeout: 900000.5 }),
  call({ command: "pnpm prChecks", timeout: 1e21 }),
  call({ command: "pnpm prChecks", timeout: -5 }),
  call({ command: "pnpm prChecks", timeout: "3600000" }),
  call({ command: "pnpm prChecks", timeout: null }),
  call({ command: "pnpm prChecks", timeout: 3600000 }, "/p", true),
  // The other two narrowings node applies: a codex `model` and the camelCase sub-agent id.
  `{"model":"gpt-5","tool_input":{"command":"pnpm prChecks","timeout":3600000}}\n`,
  `{"model":"gpt-5","tool_input":{"command":"server &"}}\n`,
  `{"agentId":"a1","tool_input":{"command":"npx vite","run_in_background":true}}\n`,
  `{"agentId":"a1","tool_input":{"command":"server &","run_in_background":true}}\n`,
  call({ command: "echo \"timeout\":3600000 \"run_in_background\":true", description: "timeout" }),
  call({ command: "x", description: "\"timeout\"", timeout: 3600000 }),
  // The `"tool_input":` marker and the escapes that could hide a key or an `&`.
  call({ command: "ls" }, "/home/u/R&D/.frizz/worktrees/x"),
  call({ command: "git status" }, "/home/u/frizz/.frizz/worktrees/x"),
  call({ command: "echo \"tool_input\": worktree" }),
  call({ command: "echo \u0001 & disown" }),
  call({ command: "printf '\\u2014'" }),
  call({ command: "a \u2028 b" }),
  // Not Claude's encoding, but valid JSON node would read: escapes, whitespace, duplicates, other order.
  `{"tool_input":{"command":"server \\u0026"}}\n`,
  `{"tool_input":{"command":"git \\u0077orktree add /abs/elsewhere"}}\n`,
  // An escaped backslash, then a real escape: `\\\u0077` decodes to `\w`, and the shell reads `\w` as w.
  `{"tool_input":{"command":"git \\\\\\u0077orktree add /abs/elsewhere"}}\n`,
  // \b: a tab is a boundary node's segmenter splits on, and it arrives as the escape `\t`.
  call({ command: "git worktree\tadd ../elsewhere" }),
  call({ command: "cd /home/u/p && git worktree add ../elsewhere -b x" }, "/home/u/p/.frizz/worktrees/y"),
  // The real key spelled with a space, and an impostor `"tool_input":` inside a later key: only the bare
  // quoted name, counted, sees both.
  `{"tool_input" :{"command":"server &"},"a\\"tool_input":1}\n`,
  `{"tool_input"\t:{"command":"x","timeout":3600000},"b\\"tool_input":{}}\n`,
  `{"tool_input":{"command":"x","\\u0074imeout":3600000}}\n`,
  `{"tool_input":{"command":"x","run_in_background" : true}}\n`,
  `{"tool_input":{"command":"x","timeout" : 3600000}}\n`,
  `{"tool_input":{"command":"x","timeout":5,"timeout":3600000}}\n`,
  `{"tool_input":{"command":"x","run_in_background":false,"run_in_background":true}}\n`,
  `{"tool_input":{"command":"x","timeout":9e5}}\n`,
  `{"tool_input":{"command":"x","timeout":9E6}}\n`,
  `{"tool_input":{"command":"x","timeout":3600000\n}}\n`,
  `{"tool_input" : {"command":"server &"}}\n`,
  `{"tool_input":{"command":"ok"},"tool_input":{"command":"server &"}}\n`,
  `{"x":{"tool_input":{}},"tool_input":{"command":"server &"}}\n`,
  `{"tool_input":{"command":"server &","x":{"tool_input":1}}}\n`,
  `{"tool_input":{"command":"server &"}}`,
  `{"tool_input":\n{"command":"server &"}}\n`,
  `{"tool_input":{"command":"server &"}}\n\n\n`,
  `{"tool_input":{"command":"ok"}}\n{"tool_input":{"command":"server &"}}\n`,
  // Malformed or empty — node answers {} and so may this.
  "", "\n", "garbage", "{", "[]", "null", `{"tool_input":{"command":"server &"`, `{"tool_input":"server &"}\n`, `{"tool_input":{"command":["server", "&"]}}\n`,
  `{"tool_input":{"command":{"x":"server &"}}}\n`,
  // Big: over the 64KB cap, and just under it.
  call({ command: `cat > f <<'EOF'\n${"x".repeat(70_000)}\nEOF` }),
  call({ command: `cat > f <<'EOF'\n${"x && y 2>&1 ".repeat(5_000)}\nEOF` }),
  call({ command: `echo ${"a".repeat(60_000)} && server &` }),
]

// Calls the pre-filter must answer itself — the common shapes, so a filter that hands off everything
// (and so trivially never skips wrongly) fails here.
const MUST_SKIP = [
  call({ command: "cd /home/u/frizz/.frizz/worktrees/x && nub --test a.test.ts 2>&1 | tail" }, "/home/u/frizz/.frizz/worktrees/x"),
  call({ command: "git worktree_list_is_not_a_word" }),
  call({ command: "printf '\\u2014\\n'" }),
  call({ command: "dir" }, "C:\\Users\\u\\proj"),
  call({ command: "git status", description: "Show working tree status" }),
  call({ command: "cd /home/u/frizz && nub run typecheck 2>&1 | tail -20", timeout: 600000, description: "Typecheck" }),
  call({ command: "nub --test packages/server/src/x.test.ts 2>&1 | tail -40", timeout: 900000 }),
  call({ command: "grep -rn foo . &>/dev/null && echo hit || echo miss", run_in_background: false }),
  call({ command: "ls" }, "/home/u/R&D/.frizz/worktrees/x"),
  call({ command: "pnpm prChecks", timeout: 3600000 }, "/p", true).replace(/"timeout":3600000/, '"timeout":600000'),
]

test("every corpus call the pre-filter answers itself, node answers {} too", { skip }, async (t) => {
  const path = process.env.BASH_PREFILTER_CORPUS ?? join(here, "bash-background-prefilter.corpus.jsonl")
  const stdins = loadCorpus(path)
  assert.ok(stdins.length >= 500, `corpus at ${path} holds ${stdins.length} inputs`)
  const verdict = await check(stdins, {}, process.env.BASH_PREFILTER_CORPUS ? 24 : 12)
  t.diagnostic(`${path}: ${stdins.length} inputs — ${verdict.skipped} answered by sh, ${verdict.handedOff} handed to node (${verdict.neededNode} of them needed it)`)
  assert.deepEqual(verdict.violations.slice(0, 10), [])
  // Every call node acts on reached node, and the filter is not a no-op: most corpus calls never do.
  assert.ok(verdict.handedOff >= verdict.neededNode)
  assert.ok(verdict.skipped >= stdins.length * 0.5, `only ${verdict.skipped} of ${stdins.length} skipped node`)
})

test("adversarial inputs: never skipped where node acts, the hand-off is byte-identical, and the common calls skip", { skip }, async () => {
  const verdict = await check(ADVERSARIAL)
  assert.deepEqual(verdict.violations, [])
  assert.ok(verdict.neededNode >= 40, `the adversarial set must reach node's every branch (${verdict.neededNode})`)
  for (const stdin of MUST_SKIP) {
    assert.equal(nodeAnswer(stdin), "{}", stdin)
    assert.equal((await runPrefilter(stdin)).stdout, "{}", stdin)
  }
})

// Probed with the shell's own arguments: `busybox -c true` fails where `busybox sh -c true` works, and
// filtering on the bare command silently dropped busybox from this list.
const SHELLS = [["dash"], ["bash"], ["bash", "--posix"], ["busybox", "sh"]].filter(([cmd, ...args]) => spawnSync(cmd, [...args, "-c", "true"]).status === 0)
test("every POSIX shell available here takes the same decisions", { skip }, async (t) => {
  t.diagnostic(`shells: ${SHELLS.map((s) => s.join(" ")).join(", ")}`)
  const sample = [...ADVERSARIAL, ...MUST_SKIP, ...loadCorpus(join(here, "bash-background-prefilter.corpus.jsonl")).slice(0, 300)]
  const decisions = async (shell: string[]) => Promise.all(sample.map(async (stdin) => (await runPrefilter(stdin, { shell })).stdout))
  const reference = await decisions(["sh"])
  for (const shell of SHELLS) {
    const verdict = await check(sample, { shell })
    assert.deepEqual(verdict.violations, [], shell.join(" "))
    assert.deepEqual(await decisions(shell), reference, shell.join(" "))
  }
})

test("outside a worker every call is {}; a blank FRIZZ_THREAD or any argument goes to node", { skip }, async () => {
  const denial = call({ command: "server &" })
  for (const env of [{}, { FRIZZ_THREAD: "" }] as Record<string, string>[]) {
    assert.equal(nodeAnswer(denial, env), "{}")
    assert.equal((await runPrefilter(denial, { env })).stdout, "{}")
  }
  // Node trims FRIZZ_THREAD; the pre-filter does not, so a blank-but-set one is treated as a worker:
  // an ordinary call still skips (node answers `{}` either way), and a denial goes to node to decide.
  const blank = { FRIZZ_THREAD: " " }
  assert.equal(nodeAnswer(denial, blank), "{}")
  assert.equal((await runPrefilter(denial, { env: blank })).stdout, `${HANDED_OFF}${denial}`)
  assert.equal((await runPrefilter(call({ command: "ls" }), { env: blank })).stdout, "{}")
  assert.equal((await runPrefilter(call({ command: "ls" }), { args: ["--frizz-thread"] })).stdout, `${HANDED_OFF}${call({ command: "ls" })}`)
})

// The negative control: each check, removed alone, lets through a call node acts on. If a mutation
// below stops applying, the check it names was rewritten and this list must follow it.
const MUTANTS: [name: string, from: string, to: string][] = [
  ["the \\u-after-a-non-backslash check", "*[!\\\\]'\\u'* | ", ""],
  ["the \\u-after-three-backslashes check", " | *'\\\\\\u'*", ""],
  ["counting the bare key, not its colon form", "*'\"tool_input\"'*'\"tool_input\"'*", "*'\"tool_input\":'*'\"tool_input\":'*"],
  ["the duplicate key check", "    *'\"tool_input\"'*'\"tool_input\"'*) return 1 ;;\n", ""],
  ["requiring the marker", "    *'\"tool_input\":'*) ;;\n    *) return 1 ;;\n", "    *) ;;\n"],
  ["the worktree check", "    *'\"tool_input\":'*worktree[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*) return 1 ;;\n", ""],
  ["counting a backslash as a word character after worktree", "0123456789_]*) return 1", "0123456789_\\\\]*) return 1"],
  ["the & neighbour check", "*'\"tool_input\":'*[!\\&\\>\\<]\\&[!\\&\\>]* | ", ""],
  ["refusing a backslash before &", "[!\\&\\>\\<]\\&[!\\&\\>]*", "[!\\&\\>\\<\\\\]\\&[!\\&\\>]*"],
  ["accepting only & or > after &", "\\&[!\\&\\>]*", "\\&[!\\&\\>\\|]*"],
  ["the run_in_background check", "    *'\"tool_input\":'*'\"run_in_background\"'*) return 1 ;;\n", ""],
  ["the duplicate run_in_background check", "    *'\"tool_input\":'*'\"run_in_background\"'*'\"run_in_background\"'*) return 1 ;;\n", ""],
  ["the timeout check", "    *'\"tool_input\":'*'\"timeout\"'*) return 1 ;;\n", ""],
  ["the duplicate timeout check", "    *'\"tool_input\":'*'\"timeout\"'*'\"timeout\"'*) return 1 ;;\n", ""],
  ["the 15m bound", "'\"timeout\":'[0-8]", "'\"timeout\":'[0-9]"],
  ["the exact 15m value", "'\"timeout\":900000'", "'\"timeout\":900001'"],
  ["the number terminator", "[0-9][0-9][0-9][0-9][0-9][,\\}]* | \\\n", "[0-9][0-9][0-9][0-9][0-9]* | \\\n"],
  ["refusing other arguments", "[ $# -eq 0 ] || return 1", ""],
]
test("NEGATIVE CONTROL: the pre-filter with any one check removed skips a call node acts on", { skip }, async () => {
  const source = readFileSync(PREFILTER, "utf8")
  const dir = tempDir("frizz-prefilter-mutant-")
  const argsCase = call({ command: "server &" })
  for (const [name, from, to] of MUTANTS) {
    assert.ok(source.includes(from), `mutation for ${name} no longer applies`)
    const script = join(dir, "bash-background.sh")
    writeFileSync(script, source.replace(from, to))
    const verdict = await check(ADVERSARIAL, { script })
    const argsSkipped = name === "refusing other arguments" && (await runPrefilter(argsCase, { script, args: ["--frizz-thread"], env: {} })).stdout === "{}"
    assert.ok(verdict.violations.some((v) => v.startsWith("SKIPPED")) || argsSkipped, `removing ${name} went unnoticed`)
  }
})

test("FAIL OPEN: a syntax or fatal runtime error in the pre-filter still reaches node, never exit 2", { skip }, async () => {
  const source = readFileSync(PREFILTER, "utf8")
  const dir = tempDir("frizz-prefilter-broken-")
  const anchor = "prefilter_skippable() {\n"
  assert.ok(source.includes(anchor))
  for (const [name, broken] of [
    ["syntax error before stdin is read", source.replace("prefilter_nl='", "if then\nprefilter_nl='")],
    ["syntax error after stdin is read", source.replace(anchor, `${anchor}  if then\n`)],
    ["fatal runtime error", source.replace(anchor, `${anchor}  : \${prefilter_unset_on_purpose?boom}\n`)],
  ] as const) {
    const script = join(dir, `${name.replace(/\W+/g, "-")}.sh`)
    writeFileSync(script, broken)
    for (const shell of SHELLS) {
      for (const stdin of [call({ command: "server &" }), call({ command: "ls" })]) {
        const run = await runPrefilter(stdin, { script, shell })
        assert.equal(run.status, 0, `${name} under ${shell.join(" ")}: ${run.stderr}`)
        assert.equal(run.stdout, `${HANDED_OFF}${stdin}`, `${name} under ${shell.join(" ")}`)
      }
    }
  }
})

// The registration itself, run the way Claude Code runs a shell-form hook on POSIX (`shell: true`, so
// `/bin/sh -c <command>` with CLAUDE_PLUGIN_ROOT in the env), with the real node behind it.
const hookCommand = (): string =>
  JSON.parse(readFileSync(join(hooks, "hooks.json"), "utf8")).hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Bash").hooks[0].command
test("the hooks.json command answers exactly as node alone does, through /bin/sh and the real node", { skip }, () => {
  const command = hookCommand()
  assert.match(command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/bash-background\.sh" \|\| node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/bash-background\.mjs"$/)
  const root = dirname(hooks)
  const env = { ...process.env, ...WORKER, CLAUDE_PLUGIN_ROOT: root, FRIZZ_WORKTREE_DIR: "" }
  for (const stdin of [
    call({ command: "server &" }),
    call({ command: "npx vite", run_in_background: true }),
    call({ command: "pnpm prChecks", timeout: 3600000 }),
    call({ command: "git worktree add ../elsewhere" }, root),
    call({ command: "git status" }),
    call({ command: "cd x && y 2>&1 | tail", timeout: 120000 }),
  ]) {
    const viaCommand = spawnSync("/bin/sh", ["-c", command], { input: stdin, encoding: "utf8", env })
    const viaNode = spawnSync(process.execPath, [NODE_HOOK], { input: stdin, encoding: "utf8", env })
    assert.equal(viaCommand.status, 0, viaCommand.stderr)
    assert.equal(viaCommand.stdout, viaNode.stdout, stdin)
  }
  assert.ok(existsSync(PREFILTER))
})

// The pre-filter FILE missing is the one failure its own EXIT trap cannot catch: the shell exits before
// reading a line of it, and dash (Debian's /bin/sh, and `sh` on this box) exits 2 on a script it cannot
// open, which Claude reads as "block this call". The first registration, `exec sh <file>; node <file>`,
// therefore blocked EVERY Bash call whenever the file was absent. `||` hands that exit to node instead,
// which still has the untouched stdin. A missing `sh` (127) lands in the same place.
test("FAIL OPEN: with the pre-filter file or `sh` missing, or the file CRLF, the hooks.json command still answers as node does", { skip }, () => {
  const root = tempDir("frizz-prefilter-noscript-")
  const hooksDir = join(root, "hooks")
  mkdirSync(hooksDir)
  for (const file of ["bash-background.mjs", "worktree.mjs"]) copyFileSync(join(hooks, file), join(hooksDir, file))
  // The same plugin with the pre-filter checked out CRLF, as a Windows clone with core.autocrlf=true
  // would write it without .gitattributes: the `\r` breaks the very trap meant to catch it (`EXIT\r` is
  // no signal), and the next line is a syntax error, exit 2.
  const crlfRoot = tempDir("frizz-prefilter-crlf-")
  mkdirSync(join(crlfRoot, "hooks"))
  for (const file of ["bash-background.mjs", "worktree.mjs"]) copyFileSync(join(hooks, file), join(crlfRoot, "hooks", file))
  writeFileSync(join(crlfRoot, "hooks", "bash-background.sh"), readFileSync(PREFILTER, "utf8").replace(/\n/g, "\r\n"))
  // A PATH holding node and nothing else: `sh` is not found at all.
  const nodeOnly = tempDir("frizz-prefilter-nodeonly-")
  symlinkSync(process.execPath, join(nodeOnly, "node"))
  const command = hookCommand()
  for (const [name, env] of [
    ["the pre-filter file is missing", { ...process.env, ...WORKER, CLAUDE_PLUGIN_ROOT: root, FRIZZ_WORKTREE_DIR: "" }],
    ["`sh` is not on PATH", { ...WORKER, PATH: nodeOnly, CLAUDE_PLUGIN_ROOT: dirname(hooks), FRIZZ_WORKTREE_DIR: "" }],
    ["the pre-filter has CRLF line endings", { ...process.env, ...WORKER, CLAUDE_PLUGIN_ROOT: crlfRoot, FRIZZ_WORKTREE_DIR: "" }],
  ] as const) {
    for (const stdin of [call({ command: "server &" }), call({ command: "npx vite", run_in_background: true }), call({ command: "ls" })]) {
      const viaCommand = spawnSync("/bin/sh", ["-c", command], { input: stdin, encoding: "utf8", env })
      assert.equal(viaCommand.status, 0, `${name}: ${viaCommand.stderr}`)
      assert.equal(viaCommand.stdout, nodeAnswer(stdin), `${name}: ${stdin}`)
    }
  }
})

// Once the pre-filter has read stdin, a non-zero exit from it would also start hooks.json's `||` node,
// on stdin that is already drained: that second node answers `{}`, exit 0, swallowing the first one's
// failure at the cost of another node start. So after any hand-off the pre-filter exits 0 itself and
// reports node's status on stderr — both from its ordinary hand-off and from its EXIT trap.
test("a node that fails after the hand-off is started once, reported on stderr, and never blocks", { skip }, () => {
  const bin = tempDir("frizz-prefilter-failnode-")
  const count = join(bin, "calls")
  writeFileSync(join(bin, "node"), `#!/bin/sh\necho call >> '${count}'\ncat > /dev/null\necho 'node crashed' >&2\nexit 1\n`)
  chmodSync(join(bin, "node"), 0o755)
  const broken = tempDir("frizz-prefilter-failnode-trap-")
  mkdirSync(join(broken, "hooks"))
  for (const file of ["bash-background.mjs", "worktree.mjs"]) copyFileSync(join(hooks, file), join(broken, "hooks", file))
  const source = readFileSync(PREFILTER, "utf8")
  writeFileSync(join(broken, "hooks", "bash-background.sh"), source.replace("prefilter_skippable() {\n", "prefilter_skippable() {\n  if then\n"))
  for (const [name, root] of [["the ordinary hand-off", dirname(hooks)], ["the EXIT trap's hand-off", broken]] as const) {
    rmSync(count, { force: true })
    const run = spawnSync("/bin/sh", ["-c", hookCommand()], {
      input: call({ command: "server &" }),
      encoding: "utf8",
      env: { ...process.env, ...WORKER, PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_PLUGIN_ROOT: root },
    })
    assert.equal(run.status, 0, `${name}: ${run.stderr}`)
    assert.equal(readFileSync(count, "utf8"), "call\n", `${name}: node must start exactly once`)
    assert.match(run.stderr, /node crashed[\s\S]*bash-background\.sh: node exited 1; the call is allowed/, name)
  }
})
