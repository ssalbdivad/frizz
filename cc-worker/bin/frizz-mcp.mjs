#!/usr/bin/env node
// @ts-check
/**
 * frizz-mcp — THE frizz MCP server: one unified, dependency-free MCP stdio server (mounted as `frizz`,
 * so its tools are `mcp__frizz__<tool>`) carrying every capability frizz hands its own WORKERS:
 *
 *   spawn_thread     — dispatch a brand-new TOP-LEVEL frizz board thread (its own session + scratchpad +
 *                      independent drive — NOT an in-session Agent/Task helper).
 *   goal — arm ONE piece of text frizz re-sends the caller, at every rest and/or on a clock
 *                      and/or after every compaction; and READ BACK what is currently armed.
 *   timer            — arm a ONE-OFF prompt for a single instant; a thread may hold many at once.
 *   editor           — READ what the human has in front of them in VS Code / Cursor / Windsurf: the
 *                      file, the selection and its text, the open tabs, the errors and warnings.
 *
 * Future worker-facing frizz tools join the TOOLS registry below rather than mounting a second server:
 * one server keeps the worker's tool namespace coherent and the server-level pre-approval single.
 *
 * spawn_thread wraps frizz's own dispatch RPC: it reads the running server's port from a server.lock
 * and POSTs `/_frizz/<project>/rpc/dispatch`. That surface has no token auth — only a loopback-origin
 * CSRF gate — so a headerless local POST with `sec-fetch-site: same-origin` (undici sends no Origin)
 * satisfies it.
 *
 * Mounted by the server (dispatch.ts) into the Claude backend via `--mcp-config`, and into codex via
 * `-c mcp_servers.frizz` (codex-mcp.ts). Both hand this process the same env, built once in
 * frizzMcpEnv: FRIZZ_SERVER_LOCK, FRIZZ_PROJECT_ID and FRIZZ_STATE_DIR.
 *
 * BUT NOTHING HERE DEPENDS ON THAT ENV STAYING TRUE. This process lives inside a DETACHED worker
 * daemon that outlives frizz restart after restart, so anything frozen into it at spawn is a bug
 * waiting for the next "Update & Restart" to move the port. Both facts we need are therefore resolved
 * PER CALL, from files: the server's address (serverLockPort — the env hint, then the machine-wide
 * `<frizz root>/server.lock`, then any live project lock, skipping any whose pid is gone) and our own
 * project (projectSegment — the stamp, else `.frizz/.id` walked up from our cwd). The env is a hint
 * that saves a lookup; the filesystem is the truth.
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We implement exactly the four methods a
 * client drives (initialize, tools/list, tools/call, ping) plus the initialized notification. Hand-
 * rolled rather than pulling @modelcontextprotocol/sdk: the surface is tiny, it ships as one loose
 * .mjs next to bin/frizz (no build/bundle/resolution concerns), and it matches this repo's own
 * hand-rolled-RPC aesthetic. The server NEVER crashes on a bad tool call: failures come back as an
 * isError tool result so the worker sees a message instead of a dead tool.
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"

const PROTOCOL_FALLBACK = "2025-06-18"
// Comfortably above a codex dispatch's bounded rollout-discovery wait (~15s) so a legitimate slow
// dispatch is never aborted client-side (which would make the worker think it failed and retry,
// double-spawning). The server completes regardless; this is only the client's patience.
const DISPATCH_TIMEOUT_MS = 30_000

const SPAWN_THREAD = {
  name: "spawn_thread",
  description:
    "LAST RESORT — try the two cheaper exits FIRST. Follow-up work you discovered is not a reason to spawn: " +
    "if you could DO it (dispatching an in-session sub-agent, whose result comes back to you, so the work " +
    "lands on YOUR card under one review), do that instead; if the human should choose, ASK instead. " +
    "Spawn a brand-new, separate top-level frizz thread — its own board card, session, and scratchpad, " +
    "driving INDEPENDENTLY. This is FIRE-AND-FORGET: the new thread reports to the HUMAN on the board via " +
    "its own final message, and its results NEVER come back to you, the caller. It is NOT an in-session " +
    "sub-agent. It returns only the new thread's slug and a ready-to-paste markdown link " +
    "`[title](/thread/<slug>)` that opens the thread in the frizz drawer — put that link in your handoff. " +
    "USE IT ONLY for a distinct, self-contained effort that belongs on the board in its own right and whose " +
    "output you do NOT need to read. Do NOT use it for a helper whose result you must COLLECT and fold into " +
    "your own work — a self-review, a verification pass, a research prong, a critic, any collect-back helper: " +
    "those are in-session sub-agents (Claude: the Agent tool with `run_in_background`; Codex: native " +
    "delegation), which return their findings to you. Spawning such a helper here STRANDS it — its work lands " +
    "on another card and never reaches you, so you gain nothing. " +
    "Because nothing it learns ever returns to you OR to its siblings, a chain of spawned threads re-derives " +
    "the same facts in parallel and nobody notices — measured here: one thread spawned four, three of those " +
    "spawned more, and three descendants independently rediscovered the same root cause over twenty hours. " +
    "Spawn only when the work genuinely cannot ride on your own card: a different repo, a different long-lived " +
    "runtime, an effort that must outlive yours. Never spawn merely to clear your own `done` fence. " +
    "You MUST deliberately choose `model` and `effort` to match the NEW thread's task complexity — they are " +
    "required, there is NO default. Do not reflexively pick the cheapest; a hard task on a weak model/effort " +
    "wastes the whole thread.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The full task/prompt for the new thread's worker. Be self-contained — the new thread starts with empty context.",
      },
      model: {
        type: "string",
        description:
          "REQUIRED — pick by the NEW task's complexity; there is no default. For the `claude` backend: " +
          "`opus` (the TOP tier — hardest reasoning, architecture, subtle correctness/security, adversarial " +
          "review, the fix that must land), `sonnet` (ordinary substantive implementation/research), `haiku` " +
          "(simple, fully-specified mechanical work). Do NOT pick `fable`: Opus 5 is just as good and cheaper, " +
          "so a high-intensity task takes `opus` at a higher `effort`, not a different model — `fable` only " +
          "when the human explicitly asks for it. For " +
          "the `codex` backend use a codex model id instead (e.g. `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`). " +
          "Match the model to the backend you choose. Bias toward Opus/a strong model when the task is " +
          "non-trivial or its outcome is load-bearing.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "REQUIRED — reasoning effort, pick by complexity; no default. `low` only for trivial tasks; " +
          "`medium` for routine work; `high` for ordinary substantive work; `xhigh` for hard coding/agentic " +
          "work; `max` for the single hardest problems. (Codex also accepts `ultra`.)",
      },
      backend: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Optional agent backend (default `claude`). If `codex`, `model` must be a codex model id.",
      },
      title: { type: "string", description: "Optional name for the new thread: one or two SHORT words naming its subject — its camelCase handle (\"Shell budgets\" → @shellBudgets) at most 16 characters — distinct from the project's other open threads. A longer one is ignored and frizz names the thread from the prompt instead." },
      spinoff: {
        type: "string",
        description:
          "Set ONLY when fulfilling a spinoff request — a message from frizz wrapped in `<spinoff-request id=\"spn_…\">` " +
          "asking for a new thread from your conversation. Pass that id verbatim. Frizz then puts the " +
          "human's own instructions and a reference back to your thread above your `prompt`, links the two threads on " +
          "the board, and shows the human the new thread itself — so do not announce it afterwards. A spinoff is " +
          "the human's explicit request, so the last-resort caution above does not apply to it.",
      },
    },
    required: ["prompt", "model", "effort"],
  },
}

// The Goal's LIMITS, mirrored from @frizz/shared (GOAL_MAX_RUNS, GOAL_MIN/MAX_FOR_SECONDS, and the
// `for:` grammar's regex) for the same reason the timer bounds are: this file cannot import them, and a
// wrong value should be refused HERE, with an explanation, rather than come back as an HTTP 400.
const GOAL_MAX_RUNS = 10_000
const GOAL_MIN_FOR_SECONDS = 60
const GOAL_MAX_FOR_SECONDS = 30 * 24 * 60 * 60
const GOAL_FOR_RE = /^(\d{1,5})(s|m|h|d)$/
const GOAL_FOR_UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 }

const GOAL = {
  name: "goal",
  description:
    "Arm a GOAL on YOUR OWN thread: one piece of text that frizz re-sends you, on any or all of three " +
    "triggers, for as long as it is armed. The board shows it as the thread's Goal. (This tool was " +
    "named `goal` until 2026-08-28 — a summary or note that says so means this one.)\n\n" +
    "  stop_hook          — every time you come to REST. Use it to keep a long autonomous effort moving " +
    "without the human driving every step, and to rescue yourself from a wait that may never resolve.\n" +
    "  heartbeat_seconds  — on a CLOCK, whatever you are doing. This one reaches you MID-TURN: it arrives as " +
    "a queued message you read at your next tool boundary rather than waiting for you to stop, and it " +
    "never aborts what you are running. Use it for something that must be revisited on a schedule no " +
    "matter what you happen to believe at the time.\n" +
    "  post_compaction    — every time your CONTEXT IS COMPACTED, delivered into the emptied window. If " +
    "you keep notes in your scratch directory, a prompt that LINKS them comes back at the exact moment " +
    "you have lost everything else. Also mid-turn — a compaction happens while you are working.\n\n" +
    "Set at least one; any combination is fine.\n\n" +
    "MAKE IT A BOUNDED LOOP with `max_runs` and/or `for`. Either limit, once reached, DISARMS the goal " +
    "by itself — every trigger off, the text kept — and you get ONE message saying which limit ended it. " +
    "Without either it runs until you stop it, sign off, or the human switches it off. Every delivery " +
    "that actually reaches you counts as a run, whichever trigger sent it; `get` shows the count.\n\n" +
    "USE THIS RATHER THAN `CronCreate` or `ScheduleWakeup`. Those are Claude Code's own in-session " +
    "schedulers and they CANNOT fire in the runtime frizz runs you in: their gate stays shut for as long " +
    "as ANY background task of yours is outstanding, so the moment you are parked behind a background " +
    "shell or a sub-agent — exactly when you most need waking — they go silent. This one is delivered by " +
    "frizz itself and is unaffected.\n\n" +
    "READ IT BACK WITH `action: \"get\"` — and do that BEFORE any `start` that is not a fresh arming. A " +
    "thread has AT MOST ONE goal, so a `start` REPLACES whatever is there, triggers and all, " +
    "and the text you are about to destroy may not be yours: the HUMAN can edit it in the thread footer, " +
    "and a compaction can take your own memory of arming it. `get` answers with the exact text currently " +
    "armed, which triggers are on, the cadence, and when each trigger last fired. Reach for it whenever " +
    "you are about to change one trigger and keep the rest, whenever you are unsure whether you are armed " +
    "at all, and after a compaction. (A `start` also reports what it replaced, so a blind overwrite is at " +
    "least a visible one.)\n\n" +
    "The text arrives VERBATIM as an ordinary user turn, so write it as an instruction to your future " +
    "self. At most one scheduled delivery is ever outstanding and its clock runs from the last one " +
    "DELIVERED, so you can never be handed a backlog at once.\n\n" +
    "STOP IT when the work it drives is done (`action: \"stop\"`) — one left armed on a finished thread " +
    "wakes it forever. The human sees it in the thread footer and can edit or switch it off there. " +
    "Signing off with a ```done fence stops it too, every trigger at once — but only when the work is " +
    "genuinely finished, because that files the thread away and a thread nobody is watching does not " +
    "restart itself.\n\n" +
    "You can only ever arm your OWN thread — there is no parameter for anyone else's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "get"],
        description:
          "`start` arms (or replaces) this thread's goal; `stop` disarms it; `get` reads back " +
          "what is armed right now — the text, the triggers, the cadence and each trigger's last delivery " +
          "— without changing anything. `get` takes no other argument.",
      },
      prompt: {
        type: "string",
        description:
          "Required for `start`. The text delivered to you on every trigger, verbatim, as a user turn. " +
          "Make it self-contained and ACTIONABLE — say what to do and what would make it right to stop " +
          "— because you may receive it with none of the context you have right now.",
      },
      stop_hook: {
        type: "boolean",
        description:
          "Send it every time you come to rest. Defaults to true when neither `heartbeat_seconds` nor " +
          "`post_compaction` is given, so a `start` that names no mechanism still does the obvious thing.",
      },
      heartbeat_seconds: {
        type: "integer",
        description:
          "Also send it on this clock, in seconds (minimum 60, maximum 86400). Omit for no heartbeat. A " +
          "delivery is read at your next tool boundary, so a sub-minute cadence buys no promptness and " +
          "only talks over your own work.",
      },
      post_compaction: {
        type: "boolean",
        description:
          "Also send it every time your context is compacted, into the emptied window — useful when the " +
          "prompt links notes you keep in your scratch directory.",
      },
      max_runs: {
        type: "integer",
        description:
          `For \`start\`: stop after this many deliveries (1 to ${GOAL_MAX_RUNS}). The goal disarms itself ` +
          "once the last one has reached you, and you are told once. Omit for no cap.",
      },
      for: {
        type: "string",
        description:
          "For `start`: stop this long after arming — a duration in the same grammar as an ```awaiting " +
          "fence's `for:`, e.g. `30m`, `2h`, `3d` (at least `1m`, at most `30d`). The goal disarms itself " +
          "when it runs out, and you are told once. Omit for no time bound.",
      },
    },
    required: ["action"],
  },
}

// The ONE-OFF TIMER's bounds, mirrored from @frizz/shared (this file is dependency-free by design and
// ships as a loose .mjs, so it cannot import them). The server validates the same numbers; these exist so
// a wrong delay is refused HERE, with an explanation, instead of coming back as an HTTP 400.
const TIMER_MIN_DELAY_SECONDS = 10
const TIMER_MAX_DELAY_SECONDS = 30 * 24 * 60 * 60

const TIMER = {
  name: "timer",
  description:
    "Set a ONE-OFF timer on YOUR OWN thread: a piece of text frizz hands back to you at ONE instant, " +
    "ONCE. Your own alarm clock.\n\n" +
    "It is `goal`'s heartbeat with the repetition taken out, and it shares the property that " +
    "matters: the delivery reaches you MID-TURN — a queued message you read at your next tool boundary — " +
    "so it arrives when you asked for it whether or not you have stopped, and it never aborts what you " +
    "are running. Unlike a goal it fires exactly once and then is gone, so there is nothing " +
    "to switch off afterwards and nothing to sign off from.\n\n" +
    "You may have MANY armed at the same time, each with its own instant and its own text — they are " +
    "independent, unlike the single goal this thread can hold.\n\n" +
    "USE IT for anything you want to come back to at a specific time: re-check a deploy in ten minutes, " +
    "re-read a slow log at the top of the hour, revisit a decision after a build finishes. USE " +
    "`goal` instead when the thing must repeat, and remember that Claude Code's own " +
    "`CronCreate`/`ScheduleWakeup` cannot fire in the runtime frizz runs you in.\n\n" +
    "IT IS NOT A WAY TO POLL SOMETHING YOU COULD WAIT ON. If a background shell, a sub-agent or a " +
    "monitor can tell you the moment a thing happens, use that — an alarm every N seconds asking \"is it " +
    "done yet\" is strictly worse than being woken when it is.\n\n" +
    "The text arrives VERBATIM as an ordinary user turn, so write it as an instruction to your future " +
    "self — self-contained and actionable, because you may receive it with none of the context you have " +
    "now. Give exactly one of `in_seconds` or `at`. You can only ever set a timer on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "cancel", "list"],
        description:
          "`set` arms a new one-off timer (it never replaces an existing one); `cancel` withdraws one by " +
          "`id`; `list` returns the timers currently armed on this thread. Every action answers with the " +
          "resulting armed list.",
      },
      prompt: {
        type: "string",
        description: "Required for `set`. The text delivered to you when it fires, verbatim, as a user turn.",
      },
      in_seconds: {
        type: "integer",
        description:
          `For \`set\`: fire this many seconds from now (minimum ${TIMER_MIN_DELAY_SECONDS}, maximum ` +
          `${TIMER_MAX_DELAY_SECONDS} — thirty days). Give this OR \`at\`, not both. Sub-minute precision ` +
          "is not real: the delivery is read at your next tool boundary.",
      },
      at: {
        type: "string",
        description:
          "For `set`: fire at this exact instant, as an ISO-8601 timestamp (e.g. `2026-08-04T15:00:00Z`). " +
          "Give this OR `in_seconds`, not both. Must be in the future and within thirty days.",
      },
      id: {
        type: "string",
        description: "Required for `cancel`. The timer id returned by `set` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}


const WATCH_PR = {
  name: "watch_pr",
  description:
    "REGISTER A PULL REQUEST and frizz brings you back whenever something happens on it — CI turning " +
    "green or red, and every later review, approval or comment, from a human or a bot alike. Register " +
    "it, come to rest, and you are woken. Drop it when it stops mattering.\n\n" +
    "IT REPORTS REPEATEDLY, unlike a timer. One registration covers the whole life of the PR: CI goes " +
    "red, you push a fix, CI goes green, a reviewer comments — that is four wakes from one call, and you " +
    "never have to re-register between them. It settles itself when the PR merges or closes, because " +
    "there is then nothing left to report.\n\n" +
    "REGISTER IT THE MOMENT YOU OPEN OR PUSH A PR. Nothing else watches for you: your runtime knows " +
    "nothing about GitHub, and an ```awaiting fence STATES what you are waiting on without creating any " +
    "wait at all. This tool is the wait.\n\n" +
    "THE ```awaiting FENCE IS STILL WORTH WRITING, and it is a different job: it is how you come to REST " +
    "without frizz asking you for a handoff, and how the human sees what you are waiting for. Register " +
    "the watcher with this tool, then name the same PR in your fence's `prs:` list — and give the fence " +
    "the same long `for:` you gave the watcher, or the fence expires first and bumps you anyway.\n\n" +
    "GIVE AN EXTERNAL PR A LONG `for` — MONTHS, up to a year. A pull request into a repo nobody here " +
    "controls moves on its maintainers' clock, not yours, and a short watcher on one expires against a " +
    "PR that has not changed: a wake with nothing in it, and a re-arm. Long costs nothing — real " +
    "activity still wakes you the instant it lands, and the human snoozes or archives the thread if " +
    "they want it off the board.\n\n" +
    "REGISTERING IS IDEMPOTENT per pull request: asking twice returns the SAME id and tells you it was " +
    "already armed, so re-registering after a compaction is safe and is the right instinct. Use `list` " +
    "when you want to know what you are holding without changing anything — it answers with each PR's " +
    "current check state too.\n\n" +
    "You can only ever watch a PR on your OWN thread — there is no parameter for anyone else's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watcher (idempotent per PR); `drop` withdraws one by id; `list` reads back " +
          "everything armed on this thread, with each PR's latest check state, without changing " +
          "anything. Every action answers with the full armed set.",
      },
      target: {
        type: "string",
        description:
          "Required for `add`. The pull request, as `owner/repo#123` or a GitHub PR URL. A ref that " +
          "cannot be parsed, or a PR the server's own `gh` cannot read, is REFUSED rather than stored — " +
          "a watcher that can never fire is worse than no watcher, because you would come to rest " +
          "believing you were covered. A refusal names the reason; a transient one is worth one retry.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED for `add`. How long to watch, as a DURATION — `2h`, `3d`, `180d` (max 365d). Never " +
          "an instant, and there is no default. The watcher settles itself when this runs out and tells " +
          "you, and you re-register if you still care.\n\n" +
          "MATCH IT TO WHOSE PR IT IS, and the two cases are far apart. Your own PR, waiting on CI or on " +
          "a review you expect today: hours. A PULL REQUEST IN A REPO NOBODY HERE CONTROLS — an upstream " +
          "project, someone else's maintainers — takes as long as it takes, so give it MONTHS (`90d`, " +
          "`180d`, `365d`). A short `for` on one of those does not make it get reviewed sooner; it just " +
          "expires against a PR nothing has touched, wakes you for nothing, and costs a re-arm. That is " +
          "not hypothetical — a watcher on an external PR re-armed at the old 24h ceiling four days " +
          "running, with zero maintainer activity in between. Long is FREE here: real activity wakes you " +
          "the moment it happens either way, and the human can snooze or archive the thread whenever " +
          "they want it gone.",
      },
      id: {
        type: "string",
        description: "Required for `drop`. The watcher id returned by `add` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}

const WATCH_ISSUE = {
  name: "watch_issue",
  description:
    "REGISTER A GITHUB ISSUE and frizz brings you back whenever something happens on it — every later " +
    "comment, from a human or a bot alike, a label added or removed, someone assigned, and the issue " +
    "closing. Register it, come to rest, and you are woken. Drop it when it stops mattering.\n\n" +
    "IT REPORTS REPEATEDLY, like `watch_pr` and unlike a timer: one registration covers the whole life " +
    "of the issue, and it settles itself when the issue closes, because there is then nothing left to " +
    "report. There is no CI and no merge on an issue, so those are the only things it can say.\n\n" +
    "USE IT WHEN THE NEXT STEP IS SOMEONE ELSE'S REPLY ON AN ISSUE — a reporter you asked for a " +
    "reproduction, a maintainer you asked to triage, a discussion you are waiting to see resolved. " +
    "Nothing else watches for you: your runtime knows nothing about GitHub, and an ```awaiting fence " +
    "STATES what you are waiting on without creating any wait at all. This tool is the wait. A PULL " +
    "REQUEST is `watch_pr`, not this — `gh issue view` refuses a PR number, and so does this.\n\n" +
    "THE ```awaiting FENCE IS STILL WORTH WRITING, for the same reason it is beside `watch_pr`: it is " +
    "how you come to REST without frizz asking for a handoff, and how the human sees what you wait for. " +
    "Register the watcher, then name the same issue in the fence's `issues:` list, with the same long " +
    "`for:`.\n\n" +
    "GIVE IT A LONG `for` — an issue in someone else's repo moves on their clock, and a short watcher " +
    "expires against an issue nobody has touched: a wake with nothing in it. Months are free; real " +
    "activity wakes you the instant it lands either way.\n\n" +
    "REGISTERING IS IDEMPOTENT per issue: asking twice returns the SAME id and says so, so re-registering " +
    "after a compaction is safe. `list` reads back the issues watched on this thread without changing " +
    "anything. You can only ever watch an issue on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watcher (idempotent per issue); `drop` withdraws one by id; `list` reads " +
          "back every issue armed on this thread, with its latest state, without changing anything.",
      },
      target: {
        type: "string",
        description:
          "Required for `add`. The issue, as `owner/repo#123` or a GitHub issue URL. A ref that cannot " +
          "be parsed, a PR URL, or an issue the server's own `gh` cannot read, is REFUSED rather than " +
          "stored — a watcher that can never fire is worse than none. A refusal names the reason.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED for `add`. How long to watch, as a DURATION — `2h`, `3d`, `180d` (max 365d). Never " +
          "an instant, and there is no default. The watcher settles itself when this runs out and tells " +
          "you. An issue you are waiting on someone else to answer deserves MONTHS.",
      },
      id: {
        type: "string",
        description: "Required for `drop`. The watcher id returned by `add` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}

// The registry that replaces a ```awaiting fence's `shells:` line: a wait the worker CREATES rather
// than one it restates at every rest. Two tools rather than one action-switch, because they are two
// verbs and a worker reaching for `unwatch` should find `unwatch`. See plans/rest-by-registration.md.
const WATCH = {
  name: "watch",
  description:
    "REGISTER A WAIT on something this thread already has running — a background shell, a sub-agent — " +
    "and frizz brings you back when it finishes, or when `for` runs out.\n\n" +
    "IT IS A ROW, NOT A SENTENCE. A ```awaiting fence has the lifetime of the message carrying it; this " +
    "survives your turn ending, a compaction and a frizz restart.\n\n" +
    "IT DOES NOT REPLACE THE FENCE. Where the thread sits while you wait is an answer about each REST, " +
    "so every rest on running work still ends with a ```awaiting fence that names the work and answers " +
    "`status: working|watching|needs_input` — `working` and `watching` keep the thread out of the " +
    "human's queue, and a rest with no fence lands in it.\n\n" +
    "`for` IS REQUIRED and it is a DURATION, never an instant. When it runs out the row is CANCELLED " +
    "and you are woken to re-decide — that is deliberate, and it is what stops a wait outliving the " +
    "reason you made it. Register again if you still mean it.\n\n" +
    "THE TARGET IS CHECKED AGAINST WHAT IS ACTUALLY RUNNING, not against its shape. A handle nothing " +
    "live answers to is REFUSED rather than stored, and so is a `kind` that disagrees with what frizz " +
    "can see — a sub-agent registered as a shell is refused and told what it actually is. If you have " +
    "lost an id (a compaction, a long turn), call `activity` rather than guessing.\n\n" +
    "A SUB-AGENT NEEDS NO REGISTRATION — its return re-invokes you — so the case this exists for is a " +
    "background SHELL: frizz cannot tell a build you are waiting on from a dev server you started and " +
    "moved on from, and only you know which it is.\n\n" +
    "NEVER WATCH SOMETHING YOU INTEND TO OUTLIVE. A dev server, a log tail, a file watcher — those are " +
    "things you started, not things you are waiting for, and registering one is a wait on work that " +
    "will never finish.\n\n" +
    "REGISTERING IS IDEMPOTENT per (kind, target): asking twice returns the SAME id, says it was " +
    "already armed, and leaves the original expiry alone — so re-registering after a compaction is safe " +
    "and is the right instinct. Use `unwatch` to withdraw one. A PULL REQUEST is `watch_pr`, not this: " +
    "that one polls GitHub and reports repeatedly.\n\n" +
    "You can only ever watch work on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["shell", "agent"],
        description:
          "What the target IS. Checked against live telemetry, not taken on trust — the two kinds of " +
          "handle are both opaque runtime strings and look identical, so frizz answers this exactly " +
          "rather than guessing, and refuses a mismatch by name.",
      },
      target: {
        type: "string",
        description:
          "The handle you were shown. For a shell that is the runtime's own background-task id " +
          "(\"Command running in background with ID: bzvtnt3ig\"); its launch tool_use id and its " +
          "command label are accepted too. For a sub-agent it is the dispatch id or its description. " +
          "`activity` prints all of them.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED. How long to hold the wait, as a DURATION — `30m`, `2h`, `3d` (max 24h). Never an " +
          "instant, and there is no default: choose it for THIS wait. When it elapses the row is " +
          "cancelled and you are woken to re-decide, so an over-long guess costs a wait that outlives " +
          "its reason and a too-short one costs one extra turn. The ceiling is a DAY here, unlike " +
          "`watch_pr`'s year: a shell or a sub-agent dies with this session, so a wait on one that has " +
          "stood for a day is a wait on something already gone.",
      },
    },
    required: ["kind", "target", "for"],
  },
}

// A BACKGROUND SHELL'S RUNTIME BUDGET (2026-09-29). A shell carries one only when it was DECLARED — its
// Bash `timeout`, or this verb; there is no default (server shell-budget.ts) — and outliving it earns one
// warning and then a stop. This is both the "keep it" answer and the way to GIVE a budget to a shell
// launched without one. Its own verb rather than a `watch` option: a watch HOLDS the thread for a shell,
// this sets how long a shell may live, and a dev server the worker is not waiting on may need the second
// and must never get the first.
const EXTEND_SHELL = {
  name: "extend_shell",
  description:
    "SET OR EXTEND A BACKGROUND SHELL'S RUNTIME BUDGET — when frizz may stop it.\n\n" +
    "A background shell has a budget only if one was declared: the Bash `timeout` you passed on the " +
    "`run_in_background` call, or this tool. With none, frizz never stops it — it runs until it exits or " +
    "you stop it, which is right for a dev server or watcher meant to keep running. Past a budget frizz " +
    "wakes you once (mid-turn if you are busy) and, if you do nothing, stops the shell ten minutes later.\n\n" +
    "Call this (a) to GIVE a budget to a shell launched without one — a poller, build or check that should " +
    "not outlive its purpose (a codex exec can get one no other way); (b) to answer that warning when the " +
    "shell must keep running; (c) ahead of time for a budgeted shell you know will run long.\n\n" +
    "`for` is counted from NOW, not from launch, so pass how much LONGER it may run. Max 24h per call; " +
    "call again before it runs out if it needs more. A shell you no longer need should be stopped " +
    "instead (TaskStop), not extended. An armed `watch` on the shell already holds its budget to the " +
    "watch's own `for:`.\n\n" +
    "You can only extend a shell on your OWN thread. `activity` prints each shell's id and its budget, " +
    "or that it has none.",
  inputSchema: {
    type: "object",
    properties: {
      shell: {
        type: "string",
        description:
          "The shell's handle — the runtime background-task id you were shown (\"Command running in " +
          "background with ID: bzvtnt3ig\"); its launch tool_use id and its description are accepted too.",
      },
      for: {
        type: "string",
        description: "How much longer it may run, as a DURATION from now — `30m`, `2h` (max 24h).",
      },
    },
    required: ["shell", "for"],
  },
}

const UNWATCH = {
  name: "unwatch",
  description:
    "WITHDRAW A WATCH you registered with `watch`, by its id. It will not wake you any more.\n\n" +
    "Use it the moment a wait stops mattering — you decided not to wait for that build after all, or " +
    "you are about to end the thread. A watch you no longer care about still wakes you for nothing, and " +
    "it blocks `done` until it is withdrawn.\n\n" +
    "You do NOT need this when the work simply finishes: frizz settles the row itself and wakes you. " +
    "`activity` prints the id of everything you hold. A `watch_pr` / `watch_issue` id (`prw_…` / " +
    "`isw_…`) or a `timer` id (`tmr_…`) is withdrawn here too.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The watch id `watch` returned (or that `activity` lists), or a PR, issue or timer id. Only your own thread's.",
      },
    },
    required: ["id"],
  },
}

// ---- `ask` / `unask`: a question the human owes an answer to, as a ROW ------------------------------

// The question tree, generated rather than written three times over. MCP tool schemas are JSON Schema,
// and a `$ref` cycle is the natural way to express a recursive shape — but client support for one is
// uneven, and a schema a client silently drops is a tool a worker cannot call. ASK_MAX_DEPTH is 3, so
// the nesting is INLINED to exactly that depth: `followUps` simply does not exist on the deepest level,
// which makes the limit visible in the schema instead of being a refusal the worker meets at runtime.
const ASK_MAX_DEPTH = 3
/** @param {number} depth 1 = the root question. @returns {Record<string, unknown>} */
function questionSchema(depth) {
  const option = {
    type: "object",
    properties: {
      label: { type: "string", description: "The choice itself, short — this is what the answer hands back to you." },
      description: {
        type: "string",
        description:
          "The trade-off, or the evidence — and it renders INSIDE the option, always visible, so this " +
          "is where the human learns what they are choosing BEFORE they pick anything. ONE LINE is the " +
          "default and it is right most of the time: name the trade-off and stop. Earn more than that " +
          "and spend it on a shape they can SCAN — a short list, a table, a code block, the diff the " +
          "option would produce, the exact message that would be posted. Never on a RUN OF " +
          "ONE-SENTENCE PARAGRAPHS: four single sentences stacked with blank lines between them is the " +
          "shape that keeps arriving, and it is the least readable one in a card this narrow. An " +
          "option with no trade-off makes the human reconstruct your reasoning before they can choose; " +
          "an option with four paragraphs makes them read an essay to answer one question. WHEN THE " +
          "OPTION SENDS OR APPLIES SOMETHING YOU WROTE — a comment, an issue body, a diff — put ALL of " +
          "it here, never \"the draft above\": the human chooses from this card, and your message's " +
          "prose above it is clipped to its first few lines.",
      },
      recommended: {
        type: "boolean",
        description:
          "Mark the ONE option you would take, and put it first. At most one per question — a " +
          "recommendation on two of three choices says nothing. IF YOU CAN MARK ONE, ASK YOURSELF WHY " +
          "YOU ARE ASKING: you already know the answer, so implement it and say which way you went. " +
          "This is for the fork you genuinely cannot take yourself. AND IT IS THE DEFAULT: a question " +
          "still unanswered 10 minutes after you rest on it takes this option for the human (never on " +
          "a `danger`, `multi` or free-text question), and the answer reaches you marked as Frizz's " +
          "default — so mark only an option you would act on without them, or mark it `external`.",
      },
      external: {
        type: "boolean",
        description:
          "Taking this option acts OUTSIDE this machine: it files an issue, posts a comment or review, " +
          "merges, pushes, publishes, sends a message or spends money — anything that goes out under " +
          "the human's name or that others see. MARK EVERY SUCH OPTION, recommended or not. Frizz's " +
          "10-minute default never takes one: if the recommendation is `external`, the default takes " +
          "the FIRST option that is not, so order the rest with the least-blocking local choice first " +
          "(\"keep the draft in the handoff\", \"leave it for later\"). A question whose every option is " +
          "`external` waits for the human.",
      },
      // `preview` (markdown revealed under the option once picked) is RETIRED from this schema
      // (2026-09-01): detail that decides a choice must be visible before the choice, so it belongs in
      // a rich `description` now. The server still ACCEPTS the field — an in-flight worker dispatched
      // against the old schema keeps working, and the card folds it into the same always-visible body.
      ...(depth < ASK_MAX_DEPTH
        ? {
            // No `maxItems` here either (four until 2026-09-03): the tree is bounded by its DEPTH, not
            // by how many branches hang off one option.
            followUps: {
              type: "array",
              description:
                "Questions that become live ONLY if the human picks this option — the conditional " +
                "branch. A branch nobody takes is never asked and never answered, so this is how you " +
                "ask \"and if so, which?\" without asking it of somebody who said no. A `multi` " +
                "question cannot carry these (several picked options would open several branches at " +
                "once) and neither can a free-text one (there is no answer to branch on).",
              items: questionSchema(depth + 1),
            },
          }
        : {}),
    },
    required: ["label"],
  }
  return {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "THE QUESTION, on one line, in the human's own vocabulary. They have their original prompt " +
          "and nothing else — not your plan, not your notes, not the names you coined while working. " +
          "Lead with the behaviour, not the identifier. NO \"I\" AND NO \"you\": clicking an option is " +
          "the HUMAN speaking, so first and second person flip between writer and reader. Name the " +
          "actor outright instead.",
      },
      header: { type: "string", description: "A very short chip label for the card, 12 characters or so — \"Auth method\", \"Storage\"." },
      kind: {
        type: "string",
        enum: ["question", "multi"],
        description:
          "`question` = pick ONE. `multi` = pick SEVERAL, for choices that are not mutually exclusive. " +
          "A question with NO options at all is a free-text box, which is the right shape when you need " +
          "a name, a value or a sentence rather than a decision between things you have enumerated.",
      },
      danger: {
        type: "boolean",
        description:
          "The DESTRUCTIVE gate, and nothing softer: a force-push, a deletion, a history rewrite, a " +
          "production rollback. It changes two things — the card wears the risk tone, and the human's " +
          "x cannot dismiss it, because a generic close icon is not consent for something irreversible. " +
          "Declining must therefore be one of your own options.",
      },
      // No `maxItems`: the count is the worker's to choose (maintainer 2026-09-03 — "allow arbitrary
      // numbers of options"). A `multi` over a long list is a real shape, and the card letters past 26.
      options: {
        type: "array",
        description:
          "As many as the choice actually has — a fork of two, or a `multi` over twenty findings. " +
          "Omit entirely for a free-text question.",
        items: option,
      },
    },
    required: ["question", "kind"],
  }
}

const ASK = {
  name: "ask",
  description:
    "ASK THE HUMAN SOMETHING YOU CANNOT DECIDE, as a ROW they still owe an answer to. THIS IS THE ONLY " +
    "WAY TO ASK: the free-form ```question fence is retired (2026-09-11), and a fence with a question " +
    "written in its body is plain prose — no card, no answer, no sign-off. The row renders as an " +
    "answerable card on the board and in the thread, and it STAYS there: it survives your turn ending, " +
    "a compaction, a restart, and the transcript scrolling past. A fence has the lifetime of the " +
    "message carrying it, which is why a question written into one was unanswerable an hour later.\n\n" +
    "YOUR DEFAULT IS TO DECIDE, AND THIS TOOL DOES NOT CHANGE THAT. A reversible call costs minutes to " +
    "redo; a round-trip to the human costs hours with the whole effort idle. Anything derivable from " +
    "the code, the conventions or ordinary engineering judgement is yours: make it, say which way you " +
    "went, and keep moving. THE TEST THAT CATCHES ALMOST EVERY BAD QUESTION: if you are about to mark " +
    "one option `recommended`, you already know the answer — so implement it instead of asking.\n\n" +
    "ASK WHEN A WRONG GUESS WOULD BE BOTH COSTLY AND HARD TO UNDO — something destructive or " +
    "irreversible, an external-facing commitment, a security posture with real exposure, product or UX " +
    "direction that is genuinely the human's taste to set. And ask when you KNOW the answer but cannot " +
    "ACT on it: a merge, a publish, a spend, a comment that goes out under their name. Then the " +
    "recommendation is the point, and it goes first.\n\n" +
    "ASK LAST, THEN REST. The card reaches the human's queue only when you come to REST: while you are " +
    "still working your thread spins in the Active band and nobody is prompted to answer it, so a " +
    "question asked mid-work sits unseen for as long as you keep going. Finish everything that does NOT " +
    "depend on the answer FIRST, then ask, then stop. If what is left is substantial work you would do " +
    "on your recommended option anyway, the call was yours: take it, say which way you went, and do not " +
    "ask at all.\n\n" +
    "AND WHEN YOU DO STOP, THE QUESTION IS THAT REST'S SIGN-OFF — rest normally. Frizz draws its card " +
    "at the BOTTOM of that rest's handoff, below its last line, whether you mention it or not — so " +
    "nothing you write can hide one, and nothing you write comes after it. PUT EVERY WORD OF " +
    "EXPLANATION BEFORE IT: what you found, what the choice turns on, what each answer would set in " +
    "motion. Never write the question itself into your handoff (one question, one card). There is no " +
    "placement marker: an empty ```question qst_… fence draws nothing.\n\n" +
    "AT EVERY LATER REST IT IS NO LONGER YOUR SIGN-OFF, and frizz does not redraw it under your newer " +
    "handoff — it stays where you asked it. Name it under `questions:` in an ```awaiting fence while you " +
    "still need the answer (its card is then drawn at that rest), or withdraw it with `unask`. A rest " +
    "that does neither is bumped, and so is any ```awaiting fence that leaves an open question out.\n\n" +
    "AN UNANSWERED QUESTION DOES NOT WAIT FOREVER. Ten minutes after you rest on it, Frizz takes its " +
    "`recommended` option for the human and delivers that as the answer, noting it was the default — " +
    "UNLESS that option is `external` (it files, posts, merges, pushes or publishes): an act outside " +
    "this machine needs the human's own answer, so the default takes the first option that is not " +
    "`external` instead, and you must not then do the external act anyway. A `danger`, `multi` or " +
    "free-text question, one with no recommendation, or one whose every option is `external`, waits " +
    "for the human.\n\n" +
    "WHEN THE HUMAN WRITES INSTEAD OF ANSWERING, THE MESSAGE SETS YOUR OPEN QUESTIONS ASIDE, AND YOUR " +
    "NEXT REST WITHDRAWS THEM. A set-aside question no longer holds your thread: it is not your sign-off, " +
    "does not block `done`, and does not follow you to your next handoff; its card stays answerable only " +
    "while you work on the message. The message comes with a note naming them. Only one DIRECTLY " +
    "RELEVANT to what the human wrote earns `keep` — reworded if the direction changed, above all to name " +
    "an option the conversation has since raised — and a keep asks it again: it is that next rest's " +
    "sign-off, its card drawn at the bottom of that handoff. " +
    "Let the rest go; if the work later needs one, ask a new question then. Never ask again a question the " +
    "human dismissed, or one you yourself withdrew after their newest message — `ask` refuses both.\n\n" +
    "SEVERAL AT ONCE IS ONE CALL — register them together, so they render as one stack. Each must stand " +
    "alone (a question that only makes sense after another's answer is that option's `followUps`), " +
    "because ANSWERS ARRIVE ONE AT A TIME: each card is sent the moment the human completes it, so you " +
    "hear the first while they are still reading the rest, and a later one may land while you are " +
    "working. Act on each as it lands; the unanswered rest stay open.\n\n" +
    "An answer comes back to you as its own wake, restating what was asked. Withdraw one you no longer " +
    "need with `unask` — a question you have since answered yourself, still sitting on the human's " +
    "board, is worse than never having asked it.\n\n" +
    "ON AN AUTONOMOUS THREAD THIS REFUSES, and tells you the standing instruction you are working " +
    "under. A thread carrying a rest Goal has already been told to keep going and decide for itself, " +
    "so the refusal is that instruction arriving at the moment it matters. Decide, and say which way " +
    "you went in your write-up. If the call is genuinely the human's — destructive or irreversible — " +
    "put it in your FINAL MESSAGE instead of here; autonomous does not mean nobody is reading.\n\n" +
    "AN ACT IS NOT A QUESTION. When the human must PERFORM something you cannot — sign in, approve, " +
    "merge, press a button you may not — do not ask whether they will: list the steps under `steps:` " +
    "in your ```awaiting fence. That works on an autonomous thread too, and their reply wakes you.",
  inputSchema: {
    type: "object",
    properties: {
      // No `maxItems` (four until 2026-09-03): "several at once is one call" above, and a cap here told
      // a worker with six to batch them and then refused the batch.
      questions: {
        type: "array",
        minItems: 1,
        description: "The questions to register, together. Each becomes its own card and its own row.",
        items: questionSchema(1),
      },
    },
    required: ["questions"],
  },
}

const UNASK = {
  name: "unask",
  description:
    "WITHDRAW A QUESTION you registered with `ask`, by its id. Its card disappears and the human is " +
    "never asked.\n\n" +
    "Use it the moment the question stops mattering: you worked out the answer yourself, the code moved " +
    "and the fork is gone, the human's newest message made it moot, or you are about to finish. A stale " +
    "question on someone's board is worse than no question — they answer it, and the answer is about a " +
    "decision that no longer exists. Withdrawn after the human's newest message, it is a pivot you " +
    "declared, and `ask` will not take it back.\n\n" +
    "You do NOT need this for a question that gets answered; that settles itself and wakes you. " +
    "Withdrawing is YOUR move and is never reported back to you as news.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The question id `ask` returned, or that `activity` lists. Only your own thread's." },
    },
    required: ["id"],
  },
}

const KEEP = {
  name: "keep",
  description:
    "KEEP A QUESTION CURRENT after the human wrote to you without answering it. Their message set it " +
    "aside: it no longer holds your thread or follows you to your next handoff, and frizz WITHDRAWS it " +
    "when you next come to rest. `keep` opts it back in — it is your sign-off again, blocks `done` again, " +
    "and its card rides to the bottom of your next handoff.\n\n" +
    "Keep only a question DIRECTLY RELEVANT to what the human just wrote. Writing past a question is " +
    "usually the human moving on, so the default is to let it go; if the work later needs the answer, " +
    "ask a new question then. If the direction shifted the " +
    "choice — a new option came up, one is gone, the recommendation changed — pass `question` with the " +
    "full reworded question, which replaces the card's wording. A card still reading as it did before " +
    "the human's message is the stale ask this exists to avoid.\n\n" +
    "Also rewords a question that is still current, if the work moved under it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The question id `ask` returned, or that `activity` lists. Only your own thread's." },
      question: { ...questionSchema(1), description: "The question's new wording, whole — it replaces the old one. Omit to keep it as asked." },
    },
    required: ["id"],
  },
}

const DONE = {
  name: "done",
  description:
    "DECLARE THIS EFFORT FINISHED, with the write-up the human reads. Your thread cards as a checked " +
    "success in their queue and stays there until they archive it — marking done is not dismissal, and " +
    "it does not close, archive or hide anything.\n\n" +
    "FRIZZ CAN REFUSE THIS, which is the whole reason it is a tool rather than a fence. An OPEN " +
    "QUESTION or an ARMED REGISTRATION blocks it, and the refusal names each one by id: a question " +
    "nobody answered dies with the card, and a live wait means the thing you were waiting for has not " +
    "happened yet. Resolve them for real — answer it yourself and `unask`, or `unwatch` the wait you no " +
    "longer need — then call again. There is no force parameter and there will not be one.\n\n" +
    "IT ONLY COUNTS WHAT IS REGISTERED. A background shell or a sub-agent you never registered does " +
    "not block this, because frizz cannot tell a build you are waiting on from a dev server you walked " +
    "away from. That judgement is yours, and registering it is how you make it.\n\n" +
    "DONE MEANS THE WORK LANDED, NOT THAT YOU STOPPED. Code committed to the project's mainline; a " +
    "plan, doc or commissioned report written INTO A FILE. An open pull request is not done — the " +
    "merge is. An investigation headed for a fix is not done — the fix is. And a verdict that ends in " +
    "SOMEBODY SHOULD NOW DO SOMETHING (merge it, post this, pick one of these) is not done either: " +
    "that is an `ask`, carrying your recommendation as the first option.\n\n" +
    "THE TEST IS NEVER \"HAVE I STOPPED WORKING\". It is: WHAT IS LOST IF NOBODY EVER OPENS THIS " +
    "THREAD AGAIN? Name one thing and you are not done. Uncertain is not done.",
  inputSchema: {
    type: "object",
    properties: {
      body: {
        type: "string",
        description:
          "THE CARD, as markdown, read at a glance — keep it SHORT. At most one sentence, then one " +
          "ONE-LINE bullet per deliverable (no sub-bullets), each opening with a bolded verb phrase naming what shipped and where. Backtick every path, identifier and " +
          "command, and make file references real links. It is a LEDGER, not a summary: reasoning, " +
          "caveats and anything the human must do belong in your final message instead, because a " +
          "sentence that would read the same in both places belongs in exactly one of them. Nothing " +
          "here may point vaguely forward — no \"a follow-up could…\". Do it, ask about it, or drop it.",
      },
      quiet: {
        type: "boolean",
        description:
          "ONLY on a SCHEDULED RUN (your first message opened with a <scheduled-run> header), and only when you " +
          "found nothing that needs the human: the thread goes straight to Done instead of their queue, and the " +
          "body's FIRST LINE becomes this run's line in the schedule's history — so make it the finding " +
          "(\"Nothing new — no issues since Oct 5\"). Anything the human should see is not quiet. Refused on any " +
          "other thread.",
      },
    },
    required: ["body"],
  },
}

const TITLE = {
  name: "title",
  description:
    "NAME THIS THREAD on the human's board — only if it has no name yet. Frizz names every thread at " +
    "dispatch, and that name is the thread's @handle: the human reads it on the board and types it to " +
    "point other threads at this one, so it NEVER changes once shown. Frizz refuses this call on a " +
    "thread that already has a name and tells you the name; that is the normal answer, not a failure — " +
    "do not retry it. It only lands on a thread Frizz could not name.\n\n" +
    "NAME THE SUBJECT, NOT THE ACTION: one or two words — \"Shell budgets\", \"Focus mode\", \"ArkType " +
    "perf\" — never \"Fix the shell budget default\". Its kebab-case handle (\"Shell budgets\" is typed " +
    "@shell-budgets) must be at most 20 characters, and no other open thread may carry the same name.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The thread's name: ONE or TWO short words naming its subject (kebab-case handle at most 20 characters), SENTENCE case (capitalize only the " +
          "first word and proper nouns — \"Queue focus\", never \"Queue Focus\"), distinct from every " +
          "other open thread's name. No trailing period, no ticks, no issue-body quoting. Spell every " +
          "product, file and identifier the way the PROJECT spells it, not the way the prompt did.",
      },
    },
    required: ["title"],
  },
}

// THREAD-TO-THREAD, BY HANDLE. The board shows every thread under a camelCase handle (`shellBudgets`), and
// the human points one thread at another with it: "ask @shellBudgets", "reconcile with @focusMode". Two
// tools, one protocol: READ first (free, wakes nobody); MESSAGE when reading is not enough, with
// `await_reply` when you need the answer before you can go on — that parks you until it comes.
const READ_THREAD = {
  name: "read_thread",
  description:
    "READ ANOTHER THREAD by its handle — the camelCase name the board shows it under (`shellBudgets`, " +
    "`focusMode`), in this project or, when no thread here carries it, in another project Frizz has open. " +
    "The human writes these as `@shellBudgets`: \"ask @shellBudgets about " +
    "this\", \"reconcile with @focusMode\". Returns that thread's original request, its status line, " +
    "whether it is running, resting or done, its last few messages (its approach, and its handoff when it " +
    "is resting) and the files it edited.\n\n" +
    "ALWAYS READ BEFORE YOU MESSAGE: this wakes nobody and costs the other thread nothing, and it usually " +
    "answers \"what is @x doing, how, and what did it change\" on its own. For the diff itself, read the " +
    "files it lists or `git log`. It reaches finished threads too. A handle that names nothing is answered " +
    "with the handles that exist.\n\n" +
    "A thread's SUB-AGENTS answer to its handle, a dot, then theirs: `portTheParser.cacheKeys`, and a " +
    "Workflow's agents one segment further (`portTheParser.wave2.implW3`). Reading one returns its own " +
    "request and its newest messages — its report, once it has returned. It reaches sub-agents that have " +
    "already returned too; a name used twice means the running one, else the latest.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The other thread's handle, or a sub-agent's `thread.subAgent` address — with or without the `@`, any casing." },
    },
    required: ["handle"],
  },
}

const MESSAGE_THREAD = {
  name: "message_thread",
  description:
    "SEND A MESSAGE TO ANOTHER OPEN THREAD by handle (`@shellBudgets`) — in this project, or another " +
    "project Frizz has open when no thread here carries the handle — to ask it a " +
    "question, to tell it what you are doing and how, or to agree who changes what. It arrives in that " +
    "thread's conversation signed with THIS thread's handle, joining its current turn if it is working and " +
    "waking it if it is resting. Nothing reaches the human.\n\n" +
    "THE PROTOCOL:\n" +
    "- ASKING, and you need the answer before you can go on → `await_reply: true`. You are PARKED until " +
    "that thread messages you back (or `for` runs out, default 1h), so rest right after, with nothing " +
    "else to sign off: the wait is registered like a timer and shows in `activity`. Its answer arrives as " +
    "a message of its own and ends the wait.\n" +
    "- ASKING, but you have other work → leave `await_reply` off and keep working; the answer still " +
    "arrives as a message.\n" +
    "- TELLING (context, your approach, a heads-up that you are changing a shared file) → no " +
    "`await_reply`. The other thread answers only if it has something to say.\n" +
    "- ANSWERING a message you received → message its sender back. When the sender is waiting on you, " +
    "its message says so; answer it promptly, even if only to say you cannot help.\n\n" +
    "`read_thread` FIRST — often it already answers the question. Write each message to stand alone: " +
    "the other thread has none of your context. Never reply just to acknowledge. A finished thread cannot " +
    "be messaged (read it instead), and neither can a sub-agent (`thread.subAgent`): only its own thread " +
    "reaches it, so message that thread. Messages between two threads are capped per hour.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The other thread's handle, with or without the `@` — any casing." },
      message: { type: "string", description: "What to tell or ask it, self-contained." },
      await_reply: {
        type: "boolean",
        description: "Park this thread until that thread answers. Use when you need the answer before you can go on.",
      },
      for: {
        type: "string",
        description: "With `await_reply`: how long to wait for the answer, as a duration — `30m`, `2h` (default 1h, max 24h). If it runs out you are woken to decide what to do without it.",
      },
    },
    required: ["handle", "message"],
  },
}

// THE HUMAN'S EDITOR, ON DEMAND. The Frizz extension (packages/vscode) reports what each VS Code / Cursor /
// Windsurf window shows over its editor socket, whole, on every change; this reads the window that has
// THIS project open (server: editor-bridge.ts `editorState`). It is the agent's half of what Claude Code's
// IDE integration gives its own agent (getCurrentSelection, getOpenEditors, getDiagnostics): without it a
// human in the Frizz sidebar who asked "can you see the highlighted code?" was told no, because the only
// way a selection reached a worker was as a chip the human added by hand. The description is written to
// be REACHED FOR on the words humans actually use for code they have not pasted.
// The schedule bounds, mirrored from @frizz/shared for the same reason as the timer's: this file cannot
// import them. The server enforces all of them; these only shape the description.
const SCHEDULE_MIN_SPACING_MINUTES = 15

const SCHEDULE = {
  name: "schedule",
  description:
    "PROPOSE A RECURRING THREAD: a saved prompt Frizz starts as a FRESH thread of its own on a calendar rule — " +
    "\"every Monday at 9am triage new issues\". Use it when the human asks for something to happen " +
    "regularly (\"do this every Monday\", \"check this daily\"). It is not `goal` (which repeats in THIS " +
    "thread) and not `timer` (one instant, this thread): each run starts with no memory of this conversation, " +
    "so the prompt must stand on its own.\n\n" +
    "A SCHEDULE YOU CREATE DOES NOT RUN UNTIL THE HUMAN CLICKS TURN ON. It is a proposal; nothing you can " +
    "call activates it, and `ask` is not a way to get it turned on.\n\n" +
    "YOU WRITE THE RULE; FRIZZ COMPUTES THE RUNS. Give an RFC 5545 `rrule` (FREQ HOURLY/DAILY/WEEKLY/MONTHLY/" +
    "YEARLY with INTERVAL, COUNT, UNTIL, BYMONTH, BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE, BYSETPOS, WKST — " +
    "nothing else), a LOCAL `dtstart` (`YYYY-MM-DDTHH:MM`, wall clock, no zone) and optionally an IANA `tz` " +
    "(default: the human's own zone). ALWAYS include BYHOUR and BYMINUTE. Weekdays = BYDAY=MO,TU,WE,TH,FR; the " +
    "last day of the month = BYMONTHDAY=-1 (never above 28); the first weekday of the month = " +
    "BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1. Runs must be at least " + SCHEDULE_MIN_SPACING_MINUTES + "m apart. " +
    "Put the human's own words for when in `when`. Anything a rule cannot say (\"unless it's a holiday\", " +
    "\"the day after each release\") goes in `condition`, a short clause each run checks first.\n\n" +
    "EVERY REPLY CARRIES AN ECHO built from the rule Frizz will fire (\"Triage issues · every Monday at 9am\" " +
    "and the next runs). RELAY IT TO THE HUMAN VERBATIM — it is how a mistranslated time gets caught before it " +
    "runs. Use `dry_run` first when you are unsure; it saves nothing.\n\n" +
    "`model` and `effort` are REQUIRED, chosen for what ONE RUN must do, exactly as for `spawn_thread` — every " +
    "run is a paid agent session.\n\n" +
    "On a schedule that is already on, you may only change ONE OCCURRENCE: `skip_next`, `move_next` (to a " +
    "local time before the run after it), or `pause` it. A scheduled run uses these when its own check says " +
    "the next run should not happen as planned. Only the human resumes, edits or deletes a schedule.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "dry_run", "update", "list", "pause", "skip_next", "move_next"],
        description:
          "`create` proposes a schedule (it waits for the human's Turn on); `dry_run` validates and echoes " +
          "without saving; `update` changes a proposal YOU made that is not on yet; `list` shows this project's " +
          "schedules with their ids; `pause`, `skip_next` and `move_next` act on an active schedule by `id`.",
      },
      id: { type: "string", description: "The schedule's `sch_…` id (from `create` or `list`). For update, pause, skip_next, move_next." },
      title: { type: "string", description: "For create/dry_run (and update): one or two words naming the task's subject, sentence case — \"Triage issues\". Every run is named this." },
      prompt: { type: "string", description: "For create/dry_run (and update): what each run does, self-contained — a fresh thread with none of your context reads it." },
      when: { type: "string", description: "For create/dry_run (and update): the human's own words for when, as they said them — \"every Monday at 9am\"." },
      rrule: { type: "string", description: "For create/dry_run (and update): the RRULE value without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`." },
      dtstart: { type: "string", description: "For create/dry_run (and update): the local start, `YYYY-MM-DDTHH:MM`, at the rule's first time of day. It anchors INTERVAL." },
      tz: { type: "string", description: "Optional IANA zone like `America/New_York`. Default: the zone the human's browser reports." },
      condition: { type: "string", description: "Optional: a short clause each run checks before working — \"unless it's a US public holiday\"." },
      model: { type: "string", description: "For create/dry_run: REQUIRED, picked for one run's task — `opus`, `sonnet` or `haiku` (claude), or a codex model id with `backend: \"codex\"`." },
      effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "For create/dry_run: REQUIRED, picked for one run's task." },
      backend: { type: "string", enum: ["claude", "codex"], description: "Optional agent backend for the runs (default `claude`)." },
      reason: { type: "string", description: "For skip_next: why, in a few words — it is the run's line in the schedule's history (\"release freeze\")." },
      to: { type: "string", description: "For move_next: the new start, a local time in the schedule's zone (`2026-10-15T10:00`) or an ISO instant. Before the run after it." },
    },
    required: ["action"],
  },
}

const EDITOR = {
  name: "editor",
  description:
    "WHAT THE HUMAN HAS IN FRONT OF THEM in VS Code, Cursor or Windsurf right now: the file in front and the " +
    "lines they have SELECTED, with the selected text; where the caret is and which lines are on screen; " +
    "their other open tabs, unsaved ones marked; and the editor's errors and warnings (the Problems panel). " +
    "CALL IT WHENEVER THE HUMAN POINTS AT CODE THEY HAVE NOT PASTED — \"this\", \"here\", \"this function\", " +
    "\"the selected code\", \"what I highlighted\", \"the error\", \"why is this red\", \"what I'm looking " +
    "at\" — and before asking them which file or lines they mean. The text it returns is what they SEE, " +
    "which differs from the file on disk when the file has unsaved changes. It reads the editor window " +
    "that has this project open (the one they used last, if several do), takes nothing and changes nothing; " +
    "call it again whenever you need the current picture, since the human keeps moving.",
  inputSchema: { type: "object", properties: {}, required: [] },
  annotations: { title: "Read the human's editor", readOnlyHint: true, openWorldHint: false },
}

// The unified server's tool registry: `tools/list` returns these and `tools/call` routes by name.
// Adding a worker-facing frizz tool = one entry here + one handler in `HANDLERS` — never a second
// MCP server, so every frizz tool stays under the same `mcp__frizz__*` namespace and the same
// server-level pre-approval the dispatch layer already grants.
const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 24 * 60 * 60

const ACTIVITY = {
  name: "activity",
  description:
    "EVERYTHING YOU CURRENTLY HAVE OUT, with the id each one is named by — your background shells, your " +
    "sub-agents, your armed timers, the pull requests you registered, the `wch_…` of every watch holding " +
    "one of them, every QUESTION still owed an answer, and saved links/files with their lnk_ ids.\n\n" +
    "WHY YOU NEED IT: an ```awaiting fence names what you are waiting on BY ID, and frizz checks every " +
    "one against what is actually live. A name that matches nothing is not a park — you are bumped and " +
    "your thread queues. The same goes for the ids `unwatch` and `unask` take. So if you have lost one (a " +
    "compaction, a long turn, a wake you did not expect), call this rather than guessing. Guessing is " +
    "the failure this tool exists to remove — and it is the only way to read your open questions " +
    "WITHOUT registering or withdrawing one.\n\n" +
    "It takes nothing and changes nothing. You can only ever read your OWN thread.",
  inputSchema: { type: "object", properties: {}, required: [] },
}

const LINK = {
  name: "link",
  description: "Register a labeled URL or local file underneath this thread's prompt, alongside agents and shells. " +
    "Use for dev servers, working documents, reports, and downloads the human will need again. " +
    "The same label updates its existing row without duplicating or reordering it. " +
    "HTTP(S) destinations render as Link; local files render as File and use Frizz's existing file reader/opener. " +
    "Files must exist. Relative paths resolve from the project root; use absolute paths for worktrees. " +
    "Registration survives rests and restarts, but does not start, monitor, or verify a server. " +
    "It never blocks done or parks the thread. Read registrations with activity; remove one with unlink.",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string", description: "Short destination label, such as Open dev server or Working plan. Reuse it to update that row." },
      target: { type: "string", description: "An HTTP(S) URL, file:// URL, or existing local file path. No credentials in URLs." },
    },
    required: ["label", "target"],
    additionalProperties: false,
  },
}
const UNLINK = {
  name: "unlink",
  description: "Remove one saved link/file from this thread by its lnk_ id (returned by link or listed by activity). " +
    "Only removes the registration: it never deletes a file or stops a server.",
  inputSchema: {
    type: "object", properties: { id: { type: "string", description: "The lnk_ id of a registration on this thread." } },
    required: ["id"], additionalProperties: false,
  },
}

// WATCH_ISSUE rides at the END (2026-09-14): the tool list is read by position in frizz-mcp.test.ts, and a
// worker's runtime reads it by name, so the order costs nothing and appending breaks nothing.
// EXTEND_SHELL is appended after it for the same reason (2026-09-29), EDITOR after KEEP (2026-10-02), and
// SCHEDULE after EDITOR (2026-10-05).
const TOOLS = [SPAWN_THREAD, GOAL, TIMER, WATCH_PR, WATCH, UNWATCH, ASK, UNASK, DONE, TITLE, ACTIVITY, LINK, UNLINK, WATCH_ISSUE, EXTEND_SHELL, READ_THREAD, MESSAGE_THREAD, KEEP, EDITOR, SCHEDULE]

/** @type {Record<string, (args: Record<string, unknown>) => Promise<string>>} */
const HANDLERS = {
  [SPAWN_THREAD.name]: spawnThread,
  [GOAL.name]: goal,
  [TIMER.name]: timer,
  [WATCH_PR.name]: watchPr,
  [WATCH_ISSUE.name]: watchIssue,
  [WATCH.name]: watch,
  [ASK.name]: ask,
  [UNASK.name]: unask,
  [KEEP.name]: keep,
  [DONE.name]: done,
  [TITLE.name]: title,
  [UNWATCH.name]: unwatch,
  [ACTIVITY.name]: activity,
  [LINK.name]: link,
  [UNLINK.name]: unlink,
  [EXTEND_SHELL.name]: extendShell,
  [READ_THREAD.name]: readThread,
  [MESSAGE_THREAD.name]: messageThread,
  [EDITOR.name]: editor,
  [SCHEDULE.name]: schedule,
}

/** The `read_thread` handler: another thread's request, status, approach and newest message, by handle.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function readThread(args) {
  // `to` is accepted too: it is the name a worker reaches for first (seen on a real worker, 2026-09-29).
  const handle = typeof args.handle === "string" ? args.handle.trim() : typeof args.to === "string" ? args.to.trim() : ""
  if (!handle) throw new Error("`handle` is required — the other thread's camelCase name, e.g. `shellBudgets`")
  const r = (await callRpc("readThread", { slug: threadSlug(), handle }))?.result
  if (!r?.found && r?.subAgentOf) {
    return r.known?.length
      ? `@${r.subAgentOf} has no sub-agent called ${handle.replace(/^@/, "").split(".").slice(1).join(".")}.\n\nIts sub-agents: ${r.known.join(", ")}`
      : `@${r.subAgentOf} has not dispatched any sub-agent that can be named.`
  }
  if (!r?.found) return `No thread is called ${handle}.${knownLine(r?.known)}`
  // A sub-agent's state is its own: "done" once it has returned, with how it ended.
  const state = r.subAgentOf
    ? r.state === "done" ? `returned${r.outcome && r.outcome !== "completed" ? ` (${r.outcome})` : ""}` : r.state === "resting" ? "resting, with its own sub-agents still running" : "running"
    : r.state === "done" ? "done" : r.state === "resting" ? "resting (not working right now)" : "running (mid-turn)"
  return [
    `@${r.handle} — ${r.project ? `a thread in the ${r.project} project, ` : ""}${r.subAgentOf ? `a sub-agent of @${r.subAgentOf}, ` : ""}${state}${r.status ? `\nStatus: ${r.status}` : ""}`,
    r.request ? `\n## Its request\n\n${r.request}` : "",
    r.earlier?.length ? `\n## Its earlier messages, oldest first\n\n${r.earlier.join("\n\n---\n\n")}` : "",
    r.latest ? `\n## Its newest message${r.latestAt ? ` (${r.latestAt})` : ""}\n\n${r.latest}` : "\nIt has not said anything yet.",
    r.editedFiles?.length ? `\n## Files it edited\n\n${r.editedFiles.map((f) => `- ${f}`).join("\n")}` : "",
  ].filter(Boolean).join("\n")
}

/** The `message_thread` handler: deliver a message into another open thread's conversation, optionally
 * parking this one until it answers.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function messageThread(args) {
  const handle = typeof args.handle === "string" ? args.handle.trim() : typeof args.to === "string" ? args.to.trim() : ""
  const message = typeof args.message === "string" ? args.message.trim() : ""
  if (!handle) throw new Error("`handle` is required — the other thread's camelCase name, e.g. `shellBudgets`")
  if (!message) throw new Error("`message` is required")
  const awaitReply = args.await_reply === true || args.await_reply === "true"
  const body = { slug: threadSlug(), handle, message, ...(awaitReply ? { awaitReply: true } : {}), ...(awaitReply && typeof args.for === "string" && args.for.trim() ? { for: args.for.trim() } : {}) }
  const r = (await callRpc("messageThread", body))?.result
  if (!r?.sent) return `Not sent — ${r?.refusal ?? "Frizz did not accept it."}${knownLine(r?.known)}`
  const where = r.project ? ` (in the ${r.project} project)` : ""
  const answered = r.answered ? ` It answers the message @${r.handle} was waiting on, so that thread is no longer parked on you.` : ""
  if (r.timerId) {
    return (
      `Sent to @${r.handle}${where}, signed @${r.from}, and you are now WAITING on its answer (${r.timerId}, until ` +
      `${r.waitUntil}).${answered} Rest now unless you have other work — the wait holds your thread and needs ` +
      "no fence, and the answer arrives as a message of its own and ends the wait. If none comes in time, " +
      `that timer wakes you to decide. \`timer\` with \`action: "cancel"\` and \`id: "${r.timerId}"\` stops waiting.`
    )
  }
  return (
    `Sent to @${r.handle}${where}, signed @${r.from}.${answered} Any answer arrives as a message of its own — keep ` +
    "working. (If you need the answer before you can go on, send with `await_reply: true` instead.)"
  )
}

/** @param {unknown} known @returns {string} */
function knownLine(known) {
  return Array.isArray(known) && known.length ? `\n\nThreads in this project: ${known.join(", ")}` : ""
}

/** The `extend_shell` handler: move one background shell's runtime budget to `for` from now.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function extendShell(args) {
  const shell = typeof args.shell === "string" ? args.shell.trim() : ""
  if (!shell) throw new Error("`shell` is required — the shell's id; `activity` prints them all")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION from now like `30m` or `2h` (max 24h)")
  const result = (await callRpc("extendOwnShell", { slug: threadSlug(), shell, for: forValue }))?.result
  if (!result?.budgetEndsAt) throw new Error("Frizz did not confirm the extension")
  // A clamp is news for the same reason it is on `watch`: a worker told nothing believes it holds time it does not.
  const clamped = result.clampedFrom ? ` Your \`for: ${result.clampedFrom}\` was CAPPED at 24h.` : ""
  return (
    `\`${result.shell}\` (${result.label}): its budget now ends at ${result.budgetEndsAt}.${clamped} ` +
    "Frizz will not warn about or stop it before then. Extend again before then if it needs longer; stop it " +
    "when you no longer need it."
  )
}

/** @param {Record<string, unknown>} args @returns {Promise<string>} */
async function link(args) {
  const label = typeof args.label === "string" ? args.label.trim() : ""
  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!label || !target) throw new Error("`label` and `target` are required")
  const result = (await callRpc("upsertOwnLink", { slug: threadSlug(), label, target }))?.result
  const saved = result?.link
  if (!saved?.id) throw new Error("Frizz did not return a saved link")
  return `Registered ${saved.kind} ${saved.id}: ${saved.label}\n${saved.target}\n\nThis reference stays underneath the prompt. It does not assert a server is running or block completion. Remove it with unlink.`
}

/** @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unlink(args) {
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from link or activity")
  const result = (await callRpc("dropOwnLink", { slug: threadSlug(), id }))?.result
  return result?.dropped ? `Removed registration ${id}. No file was deleted and no server was stopped.` : `No registration ${id} on this thread.`
}

/** The `title` handler: register this thread's considered name.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function title(args) {
  const slug = threadSlug()
  const wanted = typeof args.title === "string" ? args.title.trim() : ""
  if (!wanted) throw new Error("`title` is required — one or two words naming the subject, in sentence case")
  const result = (await callRpc("setOwnThreadTitle", { slug, title: wanted }))?.result
  if (result?.accepted) return `This thread is now named "${result.title}" on the board.`
  // A duplicate, an over-long name or a spent rename: the server says which, in words the worker can
  // act on (pick another subject, or leave the name alone).
  if (result?.refusal) return `Not renamed — ${result.refusal}`
  // The refusal is REPORTED, never thrown: a human who renamed the thread owns its name, and a worker
  // told "error" would retry a call that can only ever fail again.
  if (result?.lockedByHuman) {
    return (
      `Not renamed — the human has named this thread "${result.title}" themselves, and their name ` +
      "outranks yours. Leave it; do not call this again for this thread."
    )
  }
  return `Not renamed — frizz did not accept the write. This thread still reads "${result?.title ?? slug}".`
}

/** Read out every background thing this thread has running, in the shape an awaiting fence names them.
 * @returns {Promise<string>} */
async function activity() {
  const result = (await callRpc("listOwnThreadActivity", { slug: threadSlug() }))?.result
  const items = Array.isArray(result?.activity) ? result.activity : []
  const questions = Array.isArray(result?.questions) ? result.questions : []
  const links = Array.isArray(result?.links) ? result.links : []
  // WHO THIS THREAD IS, first: the handle other threads and the human call it, and the head of every
  // sub-agent address below — the names to write in prose, where the board turns each into a link.
  const selfLine = typeof result?.handle === "string" && result.handle
    ? `This thread is @${result.handle}. Name it, other threads and every sub-agent by their @ address in anything the human reads — the board links each one.\n\n`
    : ""
  const linksBlock = links.length === 0 ? "" : "\n\nSaved links and files (not running work; remove with unlink):\n" +
    links.map((link) => `  ${link.id}  ${link.kind}: ${link.label}\n    ${link.target}`).join("\n")
  // THE QUESTIONS GET THEIR OWN SECTION, because they are not running work: a question waits on a
  // person. Since 2026-10-05 a fence names the ones still needed under `questions:` (and must name every
  // open one), so the ready-to-paste fence below carries the OWED ones too.
  //
  // OWED vs SET ASIDE (2026-09-30). A typed message sets every open question aside: it holds nothing
  // until the worker `keep`s it, and the worker's next rest withdraws it (2026-10-02). The readout lists
  // the two apart so the worker knows which ones are still its sign-off.
  const questionLine = (q) =>
    `  question: ${q.id}\n` +
    `    ${String(q?.spec?.question ?? "").replace(/\s+/g, " ").slice(0, 160)}`
  const owed = questions.filter((q) => !q?.repliedPast)
  const passed = questions.filter((q) => q?.repliedPast)
  const owedBlock = owed.length === 0 ? "" : (
    `\n\n${owed.length} question${owed.length === 1 ? "" : "s"} still owed an answer:\n\n` +
    owed.map(questionLine).join("\n") +
    "\n\nEach one blocks `done` until it is answered, dismissed or withdrawn, and draws its own card at the " +
    "BOTTOM of the handoff of the rest that asked it — never write it into a handoff, and put the " +
    "explanation above it. Answers arrive one question at a time; act on each as it lands. `unask` the " +
    "ones since decided. Any ```awaiting fence names EVERY owed one under `questions:` or is refused, and " +
    "at a rest after the one that asked, a question you neither name nor withdraw gets you bumped. In a " +
    "fence: `questions: [" + owed.map((q) => q.id).join(", ") + "]`"
  )
  const passedBlock = passed.length === 0 ? "" : (
    `\n\n${passed.length} question${passed.length === 1 ? "" : "s"} set aside — the human wrote to you since, without answering:\n\n` +
    passed.map(questionLine).join("\n") +
    "\n\nThey hold nothing — not your sign-off, not a block on `done` — and frizz withdraws each one " +
    "when you next come to rest. `keep` only one directly relevant to the human's message — reworded with " +
    "`question` if the direction changed — and it is owed again. One you withdraw yourself after their " +
    "message, or one they dismiss, cannot be asked again."
  )
  const askedBlock = owedBlock + passedBlock
  if (!items.length) {
    if (owed.length > 0) {
      return selfLine + (
        "Nothing is RUNNING on this thread — no background shells, no sub-agents, no armed timers, no " +
        "registered PRs. An ```awaiting fence can still wait on your open questions alone — " +
        "`questions:` names the human as the wait, so it needs no other name and no `for:`." +
        askedBlock + linksBlock
      )
    }
    return selfLine + (
      "Nothing is running on this thread — no background shells, no sub-agents, no armed timers, no " +
      "registered PRs, and no question still owed an answer.\n\nSo there is nothing to wait on: an ```awaiting fence " +
      "would have nothing to name, and a fence naming nothing is not a park. End with ```done, or " +
      "register a question with `ask` if you need the human." + linksBlock
    )
  }
  const lines = items.map((i) => {
    const when = i.until ? `  (fires ${i.until})` : i.since ? `  (since ${i.since})` : ""
    // A shell's runtime budget — when frizz warns about it and, unextended, stops it (`extend_shell`). A
    // shell with NONE says so: it is the one that runs until somebody stops it, and the worker reading
    // this is the somebody.
    const budget = i.budgetEndsAt ? `  [${budgetLeft(i.budgetEndsAt)}]` : i.kind === "shell" ? "  [no budget: runs until it ends or you stop it]" : ""
    // The `wch_…` id of the watch holding this item, where one is armed — this readout exists to hand a
    // worker back the ids it lost, and that includes the one `unwatch` takes.
    const held = i.watchId ? `  [watched as ${i.watchId}]` : ""
    return `  ${i.kind}: ${i.id}${when}${held}${budget}\n    ${i.address ? `@${i.address} — ` : ""}${i.label}`
  })
  // A READY-TO-PASTE FENCE, not a description of one. The frontmatter is YAML since 2026-08-24 and its
  // keys are PLURAL sequences, so an id printed on its own line is no longer something a worker can copy
  // into a fence — it has to see the shape. This tool is where the contract sends a worker that has lost
  // an id, so printing the retired one-line-per-item form would teach the very grammar frizz refuses.
  const byKind = { shell: [], agent: [], timer: [], pr: [], issue: [] }
  for (const i of items) if (byKind[i.kind] && i.id) byKind[i.kind].push(i.id)
  const block = Object.entries({ shells: byKind.shell, agents: byKind.agent, timers: byKind.timer, prs: byKind.pr, issues: byKind.issue })
    .filter(([, ids]) => ids.length > 0)
    .map(([key, ids]) => `  ${key}: [${ids.join(", ")}]`)
  // Every OWED question rides the fence too: a fence that leaves one out is refused, and a fence on
  // questions always queues, so its `status:` answer is `needs_input` whatever else it names. A set-aside
  // one is left out — it holds nothing, and the next rest withdraws it. Otherwise the template guesses
  // from the kinds — a shell or a sub-agent is usually work that finishes by itself, a PR, an issue or a
  // timer a watch — and the prose tells the worker to correct it.
  const questionIds = owed.map((q) => q.id).filter(Boolean)
  if (questionIds.length > 0) block.push(`  questions: [${questionIds.join(", ")}]`)
  const status = questionIds.length > 0 ? "needs_input" : byKind.shell.length + byKind.agent.length > 0 ? "working" : "watching"
  return selfLine + (
    `${items.length} thing${items.length === 1 ? "" : "s"} running on this thread:\n\n${lines.join("\n")}\n\n` +
    "Name the ones you are ACTUALLY waiting on in your ```awaiting fence. The frontmatter is YAML — one " +
    "PLURAL key per kind, taking a list — plus a required `for:` duration and a required `status:` " +
    "answer: `working` (the work finishes by itself; the thread shows as running), `watching` (the wait " +
    "is on something outside the thread; it is snoozed) or `needs_input` (the human can act on something " +
    "now; it goes in their queue, with what to look at BELOW a `---` line — there is no `reason:` key). " +
    "`working` and `watching` need no prose at all.\n\nEverything above, as a fence:\n\n" +
    "```awaiting\n" +
    `${block.join("\n")}\n  status: ${status}\n  for: 2h\n` +
    "```\n\nDrop the lines you are not actually waiting on — a dev server you left running is not a wait " +
    "— and change `status:` if it names the wrong place." +
    "\n\nA `watch` registration (marked `[watched as …]` above) keeps the WAKE across a compaction and a " +
    "restart, but it does not replace the fence: name the work in the fence all the same." +
    askedBlock + linksBlock
  )
}

// What `editor` says when it has nothing to show — each says WHY, because "no selection" and "no editor"
// and "the human switched it off" call for different next moves, and every one ends with the move that
// is always open: ask the human to paste it.
const EDITOR_FALLBACK = "Ask the human to paste the code, or to name the file and lines they mean."

/** The `editor` handler: the editor window that has this project open, as readable text.
 * @returns {Promise<string>} */
async function editor() {
  let result
  // This thread's own slug, when the spawn stamped one: the server answers with this thread's checkout
  // when it works somewhere other than the project root (a worktree), which changes what the human's
  // selection means to it. Never from the arguments — the tool takes none.
  const slug = process.env.FRIZZ_THREAD_SLUG || process.env.FRIZZ_THREAD
  try {
    result = (await callRpc("editorState", slug ? { slug } : {}))?.result
  } catch (err) {
    // A Frizz from before this tool answers an unknown procedure with 404; the MCP server outlives
    // restarts, so a worker can hold this tool while the server it talks to does not have it yet.
    if (/HTTP 404/.test(err instanceof Error ? err.message : String(err))) {
      return `The running Frizz cannot read the editor yet: it predates this tool. Restart Frizz to enable this. Until then: ${EDITOR_FALLBACK}`
    }
    throw err
  }
  const windows = Array.isArray(result?.windows) ? result.windows : []
  const connected = typeof result?.connected === "number" ? result.connected : 0
  if (!windows.length) {
    if (!connected) {
      return (
        "No editor is connected to Frizz, so there is nothing to read: the human is not running VS Code, " +
        `Cursor or Windsurf with the Frizz extension. ${EDITOR_FALLBACK}`
      )
    }
    // Which folders those windows have open is not this worker's to read — they are other projects — so
    // Frizz says only that they exist (editor-bridge.ts editorState).
    return (
      `${connected} editor window${connected === 1 ? " is" : "s are"} connected to Frizz, but none has this project open, ` +
      `so what the human has in front of them is in another project. ${EDITOR_FALLBACK}`
    )
  }
  const [front, ...others] = windows
  const parts = [editorWindowReport(front, editorCheckout(result?.checkout))]
  if (others.length) {
    parts.push(
      `Also open in ${others.length} other window${others.length === 1 ? "" : "s"} (not read in full; the one above was used last):\n` +
      others.map((w) => `- ${editorWindowHead(w)}${w.editor?.active ? ` — ${editorActiveLine(w.editor.active)}` : ""}`).join("\n"),
    )
  }
  return parts.join("\n\n")
}

/** "VS Code, focused now, folder /repo" — which window this is. @param {any} w */
function editorWindowHead(w) {
  const focus = w.focused ? "focused now" : typeof w.focusedAgoMs === "number" ? `last focused ${agoLabel(w.focusedAgoMs)}` : "not focused since it connected"
  const folders = Array.isArray(w.folders) && w.folders.length ? `, ${w.folders.length === 1 ? "folder" : "folders"} ${w.folders.join(", ")}` : ""
  return `${w.app} (${focus}${folders})`
}

/** "/repo/src/a.ts (typescript, unsaved changes), lines 12-20 selected" @param {any} a */
function editorActiveLine(a) {
  const traits = [a.languageId, a.untitled ? "untitled, not saved to disk" : a.dirty ? "unsaved changes" : ""].filter(Boolean).join(", ")
  const sel = a.selection ? `, ${editorLines(a.selection)} selected` : `, caret on line ${a.cursorLine}`
  return `${a.path}${traits ? ` (${traits})` : ""}${sel}`
}

/** @param {{ startLine: number, endLine: number }} r */
function editorLines(r) {
  return r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}-${r.endLine}`
}

/** "just now", "12s ago", "3m ago", "2h 5m ago" — the house grammar (durationLabel). @param {number} ms */
function agoLabel(ms) {
  return ms < 1_000 ? "just now" : `${durationLabel(Math.round(ms / 1_000))} ago`
}

// A THREAD IN A WORKTREE IS NOT LOOKING AT THE HUMAN'S COPY. About one thread in seven works in a worktree
// of its own (`.frizz/worktrees/<slug>`), while the human's editor shows the project's main checkout — so
// the file they have selected is THEIR copy, its text may not be what the worker's copy holds, and an
// absolute path read off this report points the worker's Edit at the main checkout instead of its own
// work. The server says where the calling thread works (`checkout`, editorState); the report says once
// whose copy each path is, and names the worker's own copy of the file in front. Paths stay absolute:
// that is what Read and Edit take, and an absolute path can never be resolved against the wrong folder.

/** The answer's `checkout`, or undefined when it is absent or malformed. @param {any} raw
 *  @returns {{ dir: string, root: string, kind: string } | undefined} */
function editorCheckout(raw) {
  if (!raw || typeof raw.dir !== "string" || typeof raw.root !== "string" || !raw.dir || !raw.root) return undefined
  return { dir: raw.dir, root: raw.root, kind: raw.kind === "folder" ? "folder" : "worktree" }
}

/** Whether `path` is `dir` or lies under it. @param {string} path @param {string} dir */
function editorUnder(path, dir) {
  const rel = relative(dir, path)
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))
}

/** The worker's own copy of a file the human's editor shows in the main checkout; undefined for a file
 *  already in the worker's checkout, or outside the project. @param {string} path
 *  @param {{ dir: string, root: string } | undefined} checkout */
function editorOwnCopy(path, checkout) {
  if (!checkout || !isAbsolute(path) || editorUnder(path, checkout.dir) || !editorUnder(path, checkout.root)) return undefined
  return join(checkout.dir, relative(checkout.root, path))
}

/** One window, in full: the file in front with its selection, the tabs, the problems. @param {any} w
 *  @param {{ dir: string, root: string, kind: string } | undefined} [checkout] the calling thread's own checkout */
function editorWindowReport(w, checkout) {
  const head = editorWindowHead(w)
  const e = w.editor
  if (!e) {
    return (
      `${head} has this project open, but it has not reported what it shows: its Frizz extension predates ` +
      `this, or it connected a moment ago. Updating the extension (\`nub run vscode:install\` in a Frizz ` +
      `checkout) enables it. ${EDITOR_FALLBACK}`
    )
  }
  if (!e.shared) {
    return (
      `${head} has this project open, but the human turned off sharing their editor with Frizz ` +
      `(the eye over the sidebar's prompt box, the \`frizz.shareEditorState\` setting), so nothing of it is read. ${EDITOR_FALLBACK}`
    )
  }
  // "Last changed", not "as of": the extension reports every change, so an old report is a quiet editor.
  const lines = [`${head}, last changed ${agoLabel(e.reportedAgoMs ?? 0)}.`]
  const a = e.active
  const open = Array.isArray(e.open) ? e.open : []
  const diagnostics = Array.isArray(e.diagnostics) ? e.diagnostics : []
  if (checkout) {
    const shown = [...(a && !a.untitled ? [a.path] : []), ...open.filter((f) => !f.untitled).map((f) => f.path), ...diagnostics.map((d) => d.path)]
    const where = checkout.kind === "folder" ? "your own checkout" : "your own worktree"
    if (shown.some((path) => editorOwnCopy(path, checkout))) {
      lines.push(
        "",
        `You are working in ${where}, ${checkout.dir}, but this window shows the project's main checkout, ${checkout.root}. ` +
        `A file below under ${checkout.root} is the human's copy, and what they selected is its text; the same relative ` +
        `path under ${checkout.dir} is your copy, which may differ. Read and edit yours.`,
      )
    } else if (shown.some((path) => typeof path === "string" && editorUnder(path, checkout.dir))) {
      lines.push("", `This window has ${where} open, ${checkout.dir}: the files below under it are your own copies.`)
    }
  }
  if (!a) {
    lines.push("", "No file is in front: the editor area is empty, or shows something that is not a file (a diff's old side, an output pane, a webview).")
  } else {
    const own = a.untitled ? undefined : editorOwnCopy(a.path, checkout)
    lines.push("", `In front: ${editorActiveLine(a)}.${own ? ` Your copy: ${own}.` : ""}`)
    if (a.selection) {
      const s = a.selection
      const count = s.endLine - s.startLine + 1
      if (s.withheld) {
        // The extension keeps the text of a file that may hold secrets (.env, a key) out of the frame; the
        // lines still say where the human is looking.
        lines.push(`Its text is not shared: the file may hold secrets. Read ${editorLines(s)} of the file yourself only if the task needs it.`)
      } else if (typeof s.text === "string") {
        lines.push(`Selected text (${count} line${count === 1 ? "" : "s"}${s.truncated ? `; ONLY THE START — the selection was too large to carry whole, so read the file for the rest` : ""}):`)
        // A whole-line drag ends at column 1 of the next line, so its text ends in a newline the fence
        // would show as a blank last line.
        lines.push(codeFence(s.text.replace(/\n$/, ""), a.languageId))
      } else {
        lines.push(`The selection was too large to carry its text; read ${editorLines(s)} of the file.`)
      }
    }
    lines.push(`Caret on line ${a.cursorLine}; lines ${a.visible.startLine}-${a.visible.endLine} on screen; ${a.lineCount} line${a.lineCount === 1 ? "" : "s"} in all.`)
  }
  if (open.length) {
    lines.push("", `Other open tabs, most recent first (${open.length}):`)
    for (const f of open) lines.push(`- ${f.path}${f.untitled ? " (untitled, not saved to disk)" : f.dirty ? " (unsaved changes)" : ""}`)
  }
  const errors = e.problems?.errors ?? 0
  const warnings = e.problems?.warnings ?? 0
  if (!errors && !warnings) {
    lines.push("", "Problems: no errors or warnings.")
  } else {
    const total = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`
    const shown = diagnostics.length < errors + warnings ? ` (the first ${diagnostics.length}: the file in front first, errors before warnings)` : ""
    lines.push("", `Problems: ${total}${shown}.`)
    // Grouped by file, in the order they arrived — the file in front first — so a path is written once.
    /** @type {Map<string, any[]>} */
    const byFile = new Map()
    for (const d of diagnostics) {
      if (!byFile.has(d.path)) byFile.set(d.path, [])
      byFile.get(d.path).push(d)
    }
    for (const [path, ds] of byFile) {
      lines.push(path)
      for (const d of ds) {
        const tag = d.source || d.code ? ` [${[d.source, d.code].filter(Boolean).join(" ")}]` : ""
        lines.push(`  ${d.line}: ${d.severity}: ${String(d.message).replace(/\s+/g, " ")}${tag}`)
      }
    }
  }
  return lines.join("\n")
}

/** `text` in a Markdown fence longer than any backtick run inside it. @param {string} text @param {string} [lang] */
function codeFence(text, lang) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${lang && /^[\w+#.-]+$/.test(lang) ? lang : ""}\n${text}\n${fence}`
}

/** "budget: 42m left (ends <iso>)" in the house duration grammar (`2h 35m`), or the overrun. The ISO
 *  instant rides along because the model has no clock of its own to read "42m" against later.
 * @param {string} endsAt @returns {string} */
function budgetLeft(endsAt) {
  const ms = Date.parse(endsAt) - Date.now()
  if (!Number.isFinite(ms)) return `budget ends ${endsAt}`
  if (ms <= 0) return `PAST its budget (ended ${endsAt}) — extend_shell or stop it`
  const m = Math.max(1, Math.round(ms / 60_000))
  const left = m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`
  return `budget: ${left} left, ends ${endsAt}`
}

/** @param {unknown} obj */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}
/** @param {string|number} id @param {unknown} result */
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}
/** @param {string|number} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}
/** @param {string|number} id @param {string} text @param {boolean} [isError] */
function replyTool(id, text, isError) {
  reply(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) })
}

/**
 * Whether a pid is running. EPERM means someone else's live process, which is still ALIVE.
 *
 * A lock with NO pid reads as alive: absence of evidence is not evidence of death, and discarding a
 * record written by an older or foreign publisher would turn a working server into "none found".
 */
function pidAlive(pid) {
  if (pid === undefined || pid === null) return true
  if (!Number.isInteger(pid)) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

/** A lock file's `{port, pid}`, or undefined if it is missing, malformed, or names a DEAD process. */
function liveLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!Number.isInteger(parsed?.port)) return undefined
    if (!pidAlive(parsed?.pid)) return undefined
    return { port: parsed.port, path }
  } catch {
    return undefined
  }
}

/**
 * FIND THE RUNNING FRIZZ — every call, never cached, never frozen at spawn.
 *
 * This process is spawned once, inside a DETACHED worker daemon that outlives restart after restart.
 * An address handed to it in its env is therefore true exactly until the next "Update & Restart", and
 * a worker whose only address was stale simply lost every frizz tool it had — with no way back short of
 * restarting the worker itself, which is not what an update button should mean.
 *
 * So the env is a HINT and the file is the truth, in this order:
 *   1. FRIZZ_SERVER_LOCK  — the lock this server published when it spawned us. Right almost always.
 *   2. `<frizz root>/server.lock` — the MACHINE address (frizz-paths.ts `serverAddressPath`), rewritten
 *      by every boot whatever project launched it. This is what makes a live worker survive an update.
 *   3. `<state dir>/server.lock` — our own project's, for a server that only ever serves one project.
 *   4. any live `<frizz root>/projects/*​/server.lock` — last resort, since one machine runs one frizz.
 *
 * A candidate whose PID IS DEAD IS SKIPPED, which is the difference between a legible failure and the
 * one that cost an afternoon: a stale lock from a long-dead per-project server sent every call at a port
 * nothing was listening on, and the tool reported only "fetch failed".
 *
 * The frizz root is `../..` from the state dir rather than computed: this file is dependency-free and
 * the real root is platform-dependent (XDG, `~/Library/Application Support`, a legacy `~/.frizz`).
 */
function serverLockPort() {
  const stateDir = process.env.FRIZZ_STATE_DIR
  const root = stateDir ? dirname(dirname(stateDir)) : undefined
  const candidates = [
    process.env.FRIZZ_SERVER_LOCK,
    root ? join(root, "server.lock") : undefined,
    stateDir ? join(stateDir, "server.lock") : undefined,
  ].filter(Boolean)
  for (const path of candidates) {
    const live = liveLock(path)
    if (live) return live.port
  }
  // Nothing we were told about is alive. One machine runs one frizz, so any project's live lock names
  // it — and addressing by project id (rpcPath) means a server that does not serve us answers 404
  // rather than acting on the wrong board.
  if (root) {
    let entries = []
    try { entries = readdirSync(join(root, "projects")) } catch {}
    for (const entry of entries) {
      const live = liveLock(join(root, "projects", entry, "server.lock"))
      if (live) return live.port
    }
  }
  if (candidates.length === 0) throw new Error("FRIZZ_STATE_DIR / FRIZZ_SERVER_LOCK not set — cannot locate the frizz server")
  // SAY THAT NOTHING WAS SAVED, and say to retry. A worker reads "is frizz running?" as a fact about the
  // world rather than as a fact about ITS OWN call, and moves on — so whatever it was arming is silently
  // gone. Measured 2026-08-17: a worker's `recurring_prompt start` hit a restart window, got this error,
  // carried on, and its Goal — the thing keeping a long autonomous effort alive — never existed. The
  // window is ordinary (frizz restarts, and this process outlives every one of them), so the recovery has
  // to be ordinary too: try again.
  throw new Error(
    `no running frizz server found (looked at ${candidates.join(", ")} and every project lock under ` +
    `${root ? join(root, "projects") : "the frizz root"}; each was missing, malformed, or written by a process that is gone). ` +
    `NOTHING WAS SAVED — this call had no effect. frizz is probably mid-restart, which is ordinary and ` +
    `brief; RETRY this exact call before you do anything else, and do not come to rest assuming it took.`,
  )
}

/**
 * The RPC base for OUR project.
 *
 * One frizz serves every project on the machine, and an unprefixed `/_frizz/rpc/…` is the project it
 * was LAUNCHED from — so without the prefix a worker in any other project acted on the launcher's
 * board (spawn_thread put its new thread there; the thread-scoped tools looked for a slug that lives
 * in a different registry). FRIZZ_PROJECT_ID is the immutable registry id rather than the slug,
 * because the value is handed over once at spawn and then held for the life of a detached daemon,
 * and a project can be renamed under it. Unset ⇒ unprefixed, which is what a server that only ever
 * serves one project passes, and what the launching project's own workers get.
 * @param {string} procedure
 */
function rpcPath(procedure) {
  const project = projectSegment()
  return `${project ? `/_frizz/${encodeURIComponent(project)}` : "/_frizz"}/rpc/${procedure}`
}

/**
 * WHICH PROJECT WE ACT ON — always the one this worker is actually running in.
 *
 * There is deliberately no tool parameter for it and no way to name another project: the id comes from
 * the server's stamp, or failing that from the tree we are standing in (`<root>/.frizz/.id`, the same
 * file project-root.ts treats as identity). Spawning a thread onto somebody else's board is therefore
 * not something a model can express, rather than something it is asked not to do.
 *
 * The walk-up is what makes this work for a worker spawned by a server that predates the stamp, and it
 * is the honest source anyway: a worker's project is wherever its cwd is, and that cannot go stale.
 */
function projectSegment() {
  const stamped = process.env.FRIZZ_PROJECT_ID
  if (stamped) return stamped
  let dir = process.cwd()
  for (;;) {
    try {
      const id = readFileSync(join(dir, ".frizz", ".id"), "utf8").trim()
      if (id) return id
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The `spawn_thread` handler: POST /_frizz/rpc/dispatch, return the worker-facing result text.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function spawnThread(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required and must be a non-empty string")
  // model + effort are REQUIRED (no default) so the caller must choose by task complexity — a defaulted
  // model (e.g. the project's cheap default) is exactly the bug this guards. Enforced server-side too,
  // not only in the tool schema, so a lenient client can't skip the decision.
  const model = typeof args.model === "string" ? args.model.trim() : ""
  if (!model) throw new Error("`model` is required — choose one by the new task's complexity (claude: opus/sonnet/haiku, opus being the top tier; codex: a gpt-5.6 model id). There is no default.")
  const effort = typeof args.effort === "string" ? args.effort.trim() : ""
  if (!effort) throw new Error("`effort` is required — choose one by complexity (low/medium/high/xhigh/max). There is no default.")

  /** @type {Record<string, unknown>} */
  const body = { prompt, model, effort }
  if (typeof args.title === "string" && args.title.trim()) body.title = args.title.trim()
  if (args.backend === "claude" || args.backend === "codex") body.backend = args.backend
  // A spinoff names the request it fulfils, and the CALLER — read from our own identity, never from the
  // arguments — so the server can refuse a request that belongs to another thread.
  if (typeof args.spinoff === "string" && args.spinoff.trim()) {
    body.spinoff = args.spinoff.trim()
    body.spinoffFrom = threadSlug()
  }

  const payload = await postToFrizz("dispatch", rpcPath("dispatch"), body)
  const slug = payload?.result?.slug
  if (typeof slug !== "string" || !slug) throw new Error(`dispatch response missing a slug: ${JSON.stringify(payload)?.slice(0, 300)}`)
  // The result OPENS with the same sentence either way, and the server depends on it: a spinoff whose
  // MCP server predated the `spinoff` argument is recovered from this line in the parent's transcript
  // (packages/server/src/spinoff-edge-recovery.ts, SPAWN_THREAD_RESULT_RE). Reword it there too.
  const spawned = `Spawned a new frizz thread \`${slug}\`.`
  // A SPINOFF is already on the human's screen: the chat draws the request as a card that links to this
  // new thread by name. What the worker once wrote after it — "I started [Sub-agent addresses](…)", then
  // a whole second sign-off reading "Nothing new landed here" — was the confusing part (maintainer
  // 2026-09-30), so the result tells it to announce nothing, and a resting worker that ends on two words is
  // a side turn the server folds away. Two words rather than none: a worker told to end in silence did, and
  // Claude Code re-prompted it for visible output — one more model call for every spinoff.
  if (body.spinoff) {
    return (
      `${spawned} The human's chat already shows this spinoff, linked to the new thread, so do not ` +
      `announce it, paste a link to it, or summarize your brief. If you had come to rest when the request ` +
      `arrived, end your turn now with the two words \`Spun off.\` and nothing else: Frizz keeps your previous handoff and this ` +
      `thread's state exactly as they were, so do not sign off again. If you were in the middle of work, ` +
      `carry on with it. Do not wait on the new thread; it reports to the human, not to you.`
    )
  }
  const label = typeof body.title === "string" ? body.title : slug
  return (
    `${spawned} It is now on the board driving independently — it reports ` +
    `to the human via its own final message, NOT back to you, so do not wait on a result from it.\n\n` +
    `Paste this link to let the human open it in the drawer:\n\n[${label}](/thread/${slug})`
  )
}

// HOW LONG A RESTART WINDOW IS ALLOWED TO BE INVISIBLE. frizz replaces its own server routinely
// ("Update & Restart", a dev rebuild), and this process is deliberately still here across every one of
// them — so a call landing in that gap is ORDINARY, and failing it is the shim reporting frizz's
// housekeeping as the worker's problem. Measured 2026-08-17: a `recurring_prompt start` landed in one,
// failed, and the Goal that was keeping a long autonomous effort alive silently never existed.
//
// Telling the model to retry (which the error also does) is strictly weaker than retrying, because it
// only works if the model complies. Bounded: a genuinely-down frizz still fails, with the same message —
// this only covers the window where a new server is coming up.
//
// A MINUTE, not the six seconds this started at. A boot on a loaded machine is not seconds: on
// 2026-09-29 (arktype session 50d1f5b7, load average ~15) three `ask` calls in a row each spent the
// whole 6s window and failed, the outage outlasting all three (~27s), and the worker had to notice and
// re-ask by hand. Waiting longer costs only latency on a call that would otherwise have failed.
const LOCK_RETRY_MS = 60_000
const LOCK_RETRY_INTERVAL_MS = 400

/** The port, waiting out a brief restart window rather than failing into one. Rethrows the real
 *  "no running frizz server" error once the budget is spent, so a frizz that is actually down still
 *  says so — and says it with the retry guidance attached.
 *  @param {number} deadline epoch ms; shared with postToFrizz's refused-connection retries, so the two
 *  waits together never exceed one window. */
async function serverLockPortWaiting(deadline = Date.now() + LOCK_RETRY_MS) {
  for (;;) {
    try {
      return serverLockPort()
    } catch (err) {
      if (Date.now() >= deadline) throw err
      await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS))
    }
  }
}

// A LIVE LOCK IS NOT A LISTENING PORT. The lock wait above only covers a lock that is missing or names a
// dead pid. Through the rest of a restart the lock names a pid that is still alive while its port is not
// answering — the old server between closing its listener and exiting, or a dev supervisor's child being
// replaced — and the call failed at once with a bare "fetch failed", the same non-answer the lock check
// was written to remove. Two shapes, and they need opposite advice:
//
// - REFUSED (`ECONNREFUSED`): nothing was listening, so the request never left this process. Nothing can
//   have been applied, so it is retried inside the same window, exactly as a dead lock is.
// - DROPPED after connecting (`UND_ERR_SOCKET` "other side closed", `ECONNRESET`), or no answer inside
//   DISPATCH_TIMEOUT_MS: the server had the request and may have acted on it. Retrying blindly could
//   register a question or spawn a thread twice, so the worker is told it MAY have landed and to check.
//
// Measured 2026-10-02 (session fe5967ef): a `done` spent 16s and failed with "markOwnDone request failed:
// fetch failed" during a server restart. The error carried no advice, the worker never repeated it, and
// the thread's handoff was never recorded.
/** @param {unknown} err */
function causeCode(err) {
  const cause = err && typeof err === "object" ? /** @type {{ cause?: { code?: unknown } }} */ (err).cause : undefined
  return typeof cause?.code === "string" ? cause.code : undefined
}

/** @param {string} what @param {unknown} err */
function transportFailure(what, err) {
  if (causeCode(err) === "ECONNREFUSED") {
    return new Error(
      `${what} could not reach frizz: its server refused the connection for a whole minute. NOTHING WAS SAVED — ` +
      "this call had no effect. frizz is probably mid-restart, which is ordinary; RETRY this exact call before " +
      "you do anything else, and do not come to rest assuming it took.",
    )
  }
  const aborted = err instanceof Error && err.name === "AbortError"
  const how = aborted
    ? `frizz did not answer within ${DISPATCH_TIMEOUT_MS / 1000}s`
    : `the connection to frizz dropped before it answered (${causeCode(err) ?? (err instanceof Error ? err.message : String(err))}) — it was probably restarting`
  return new Error(
    `${what}: ${how}. This call MAY OR MAY NOT have taken effect. Check before repeating it — \`activity\` ` +
    "lists what this thread has registered — and repeat it if it did not land. Do not come to rest assuming it took.",
  )
}

/** A refusal frizz wrote for the worker, without the transport wrapped around it. Every handler that
 *  throws answers HTTP 500 `{"error": "…"}` (packages/rpc errorEnvelope) and an input the schema rejects
 *  answers 400 the same way, so `extend_shell` used to read "extendOwnShell returned HTTP 500:
 *  {"error":"no background shell running…"}" — an internal procedure name, a status that says "server
 *  bug", and JSON quoting around the one sentence that mattered. Any other status (a 404 from a server
 *  that predates a procedure, which `goal get` matches on) keeps the status line.
 *  @param {string} what @param {number} status @param {string} detail */
function httpFailure(what, status, detail) {
  if (status === 400 || status === 500) {
    try {
      const error = JSON.parse(detail)?.error
      if (typeof error === "string" && error.trim()) return new Error(error.trim())
    } catch {}
  }
  return new Error(`${what} returned HTTP ${status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
}

/** POST to frizz's RPC surface at `path`, riding out a restart: waits for a live lock, and retries a
 *  refused connection, inside one LOCK_RETRY_MS window. Returns the parsed payload; throws the legible
 *  errors above.
 *  @param {string} what the procedure name, for messages @param {string} path @param {unknown} body */
async function postToFrizz(what, path, body) {
  const deadline = Date.now() + LOCK_RETRY_MS
  for (;;) {
    const port = await serverLockPortWaiting(deadline)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
    let res
    try {
      res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        // No Origin header (undici omits it for non-browser fetch); `sec-fetch-site: same-origin`
        // satisfies the server's loopback-origin gate (app.ts isTrustedLocalHttpRequest).
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (causeCode(err) === "ECONNREFUSED" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS))
        continue
      }
      throw transportFailure(what, err)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw httpFailure(what, res.status, await res.text().catch(() => ""))
    return await res.json().catch(() => null)
  }
}

/** POST a frizz RPC procedure and return its parsed payload. @param {string} procedure
 *  @param {Record<string, unknown>} body @returns {Promise<any>} */
async function callRpc(procedure, body) {
  return postToFrizz(procedure, rpcPath(procedure), body)
}

/** Which thread this MCP server belongs to. Stamped into our env at spawn (the broker bridge, on the
 * Claude SDK path) because the MCP protocol carries no caller identity.
 * FRIZZ_THREAD is the fallback: every frizz worker process is tagged with it, so it is right
 * whenever the env is inherited — but it is not relied upon, hence the explicit var first.
 *
 * This is also the reason a model can never point `goal` at someone else's thread: the slug is
 * read from HERE, never from the tool arguments. */
function threadSlug() {
  const slug = process.env.FRIZZ_THREAD_SLUG || process.env.FRIZZ_THREAD
  if (!slug) {
    // Ten tools resolve their caller through here, so the message must not name one of them. It said
    // "so it cannot arm a goal for it" for every single one — which read as a bug in `goal` no matter
    // which tool the worker had actually called, and sent at least one worker off debugging the wrong
    // thing after `title` failed on a codex thread.
    throw new Error(
      "this frizz MCP server was not told which thread it belongs to (no FRIZZ_THREAD_SLUG), so it cannot " +
      "act on the caller's own thread. This is a frizz bug — report it rather than working around it.",
    )
  }
  return slug
}

/** How a heartbeat cadence reads back to the worker. ONE formatter, because `start` and `get` describe
 * the same stored number and a worker that saw "every 15m" armed must not read "every 900s" back.
 *
 * The house duration grammar (`packages/web/src/lib/durationLabels.ts`), matching the trailer
 * `formatIntervalLabel` writes into the delivery itself — a worker reads both.
 * @param {number|undefined} seconds */
function cadenceLabel(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined
  if (seconds % 60 !== 0) return `${seconds}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes}m`
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`
}

/** Render an armed goal for the worker to read: which triggers are live, the cadence, when
 * each last fired, and the text VERBATIM (never truncated — reading back a summary of your own
 * instruction is exactly as blind as not reading it).
 * @param {{ prompt: string, stopHook: boolean, heartbeat: boolean, postCompaction: boolean,
 *           intervalSeconds?: number, armedAt: string, lastRestFiredAt?: string,
 *           lastScheduleFiredAt?: string, lastCompactFiredAt?: string, runs?: number, maxRuns?: number,
 *           forSeconds?: number, endsAt?: string, stopped?: { reason: string, at: string } }} rp */
function goalReport(rp) {
  const fired = (/** @type {string|undefined} */ at) => (at ? `last fired ${at}` : "never fired yet")
  const triggers = [
    rp.stopHook ? `  stop_hook — every time you come to rest (${fired(rp.lastRestFiredAt)})` : null,
    rp.heartbeat
      // The SAME cadence form `start` reports (cadenceLabel), or the two readings of one row disagree
      // about the number they are describing — "every 15 min" armed, "every 900s" read back.
      ? `  heartbeat — every ${cadenceLabel(rp.intervalSeconds) ?? "?"} (${fired(rp.lastScheduleFiredAt)})`
      : null,
    rp.postCompaction ? `  post_compaction — every compaction (${fired(rp.lastCompactFiredAt)})` : null,
  ].filter(Boolean)
  // EVERY trigger off is a real, reachable state — the human can switch them off in the footer without
  // clearing the words — and it is the one a worker would otherwise misread as "armed and running".
  const head = rp.stopped
    ? `STOPPED at its ${rp.stopped.reason === "runs" ? "run" : "time"} limit (${rp.stopped.at}). Every trigger is off; ` +
      "the text is kept, and nothing will fire until the goal is re-armed — which starts a fresh count."
    : triggers.length
    ? `Armed since ${rp.armedAt}, on:\n${triggers.join("\n")}`
    : `Text is parked (armed ${rp.armedAt}) but EVERY TRIGGER IS OFF — nothing will fire until one is switched back on.`
  return `${head}\n${goalRunsLine(rp)}\n\nThe text, verbatim:\n\n${rp.prompt}`
}

/** The run counter and the limits, one line — the same reading the thread footer shows.
 * @param {{ runs?: number, maxRuns?: number, forSeconds?: number, endsAt?: string }} rp */
function goalRunsLine(rp) {
  const runs = rp.runs ?? 0
  const count = rp.maxRuns ? `Run ${runs} of ${rp.maxRuns}` : `Run ${runs} (no run cap)`
  if (!rp.forSeconds) return `${count}; no time bound.`
  const leftMs = rp.endsAt ? Date.parse(rp.endsAt) - Date.now() : NaN
  const left = Number.isFinite(leftMs) && leftMs > 0 ? `, ${durationLabel(Math.round(leftMs / 1000))} left` : ""
  return `${count}; time bound ${goalForLabel(rp.forSeconds)}, ends ${rp.endsAt ?? "?"}${left}.`
}

/** A span in the house grammar, two units at most: `45s`, `12m`, `2h 5m`, `3d 4h`.
 * @param {number} seconds */
function durationLabel(seconds) {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** A time bound as the `for:` grammar writes it — the largest unit that divides it exactly.
 * @param {number} seconds */
function goalForLabel(seconds) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** The `goal` handler: arm, disarm, or READ BACK this thread's re-prompt.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function goal(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "start" && action !== "stop" && action !== "get") {
    throw new Error("`action` must be one of \"start\", \"stop\" or \"get\"")
  }

  if (action === "get") {
    // A frizz server older than this tool has no such procedure and answers 404. Say what that means,
    // rather than leaving a worker to read a bare HTTP status as "nothing is armed" — the two answers
    // could not be further apart.
    let payload
    try {
      payload = await callRpc("getOwnThreadRecurringPrompt", { slug })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(message)) {
        throw new Error(
          "this frizz server predates the read action, so it cannot tell you what is armed. Treat the " +
          "armed state as UNKNOWN — do not assume it is empty — and check the thread footer instead.",
        )
      }
      throw err
    }
    const rp = payload?.result?.recurringPrompt
    if (!rp) return "No goal is armed on this thread. Nothing will re-prompt you."
    return goalReport(rp)
  }

  if (action === "stop") {
    await callRpc("setOwnThreadRecurringPrompt", { slug, prompt: null, stopHook: false, heartbeat: false, postCompaction: false })
    return "Goal disarmed and cleared. No trigger will fire — not the stop hook, not the heartbeat, not the post-compaction one — and the text is gone from the thread footer."
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) {
    throw new Error("`prompt` is required to start a goal — it is the text you will be sent on every trigger")
  }

  const hasHeartbeat = args.heartbeat_seconds !== undefined && args.heartbeat_seconds !== null
  let interval
  if (hasHeartbeat) {
    interval = typeof args.heartbeat_seconds === "number" ? Math.round(args.heartbeat_seconds) : NaN
    if (!Number.isFinite(interval)) throw new Error("`heartbeat_seconds` must be a number of seconds")
    if (interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
      throw new Error(`\`heartbeat_seconds\` must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`)
    }
  }
  const postCompaction = args.post_compaction === true
  // DEFAULTED, not required: a `start` that names no trigger at all is a model asking to be re-prompted
  // and leaving the mechanism to us, and the rest trigger is the safe reading of that — it cannot talk
  // over a running turn, and it cannot fire on a thread that has stopped needing it.
  const stopHook = typeof args.stop_hook === "boolean" ? args.stop_hook : !hasHeartbeat && !postCompaction
  const heartbeat = hasHeartbeat
  if (!stopHook && !heartbeat && !postCompaction) {
    throw new Error("at least one is required: set `stop_hook: true`, give `heartbeat_seconds`, set `post_compaction: true`, or any combination")
  }

  // THE LIMITS. Sent EXPLICITLY, null included: a `start` replaces the whole goal, so one that names no
  // limit means an unbounded goal, not "keep whatever cap was there".
  let maxRuns = null
  if (args.max_runs !== undefined && args.max_runs !== null) {
    maxRuns = typeof args.max_runs === "number" ? Math.round(args.max_runs) : NaN
    if (!Number.isFinite(maxRuns) || maxRuns < 1 || maxRuns > GOAL_MAX_RUNS) {
      throw new Error(`\`max_runs\` must be a whole number from 1 to ${GOAL_MAX_RUNS}`)
    }
  }
  let forSeconds = null
  if (args.for !== undefined && args.for !== null && args.for !== "") {
    const m = typeof args.for === "string" ? GOAL_FOR_RE.exec(args.for.trim()) : null
    forSeconds = m ? Number(m[1]) * GOAL_FOR_UNIT_SECONDS[/** @type {"s"|"m"|"h"|"d"} */ (m[2])] : NaN
    if (!m) throw new Error("`for` must be a duration like `30m`, `2h` or `3d` — a number glued to one of s, m, h, d")
    if (forSeconds < GOAL_MIN_FOR_SECONDS || forSeconds > GOAL_MAX_FOR_SECONDS) {
      throw new Error("`for` must be between `1m` and `30d`")
    }
  }

  const written = await callRpc("setOwnThreadRecurringPrompt", {
    slug,
    prompt,
    stopHook,
    heartbeat,
    postCompaction,
    ...(heartbeat ? { intervalSeconds: interval } : {}),
    maxRuns,
    forSeconds,
  })
  // `replaced` is absent against a server that predates it, which is indistinguishable from "there was
  // nothing" — so the clause only ever appears when the row genuinely carried something.
  const replaced = written?.result?.replaced

  const every = heartbeat ? cadenceLabel(interval) : null
  // One clause per armed trigger, joined — with three of them the old nested ternary could no longer say
  // what was actually armed, and a worker that misreads which trigger it holds waits for a delivery that
  // is never coming.
  const clauses = [
    stopHook ? "every time you come to rest" : null,
    every ? `every ${every} (the heartbeat reaches you mid-turn)` : null,
    postCompaction ? "every time your context is compacted, delivered into the emptied window" : null,
  ].filter(Boolean)
  const when = clauses.length === 1
    ? clauses[0]
    : `${clauses.slice(0, -1).join(", ")} AND ${clauses[clauses.length - 1]}`
  // Spelled out in full, not summarized: if this overwrote the human's own edit, the words themselves
  // are the only way the worker can put them back.
  const superseded = replaced
    ? `\n\nIT REPLACED an existing goal — check that discarding it was intended, and restore ` +
      `it with another \`start\` if it was not:\n\n${goalReport(replaced)}\n`
    : ""
  // NO QUESTION HOLD ANY MORE (2026-08-16). Every trigger fires while you are waiting on the human, and
  // the at-rest one fires over your own unanswered registered question — the delivery says so, and expects
  // you to decide the question yourself rather than re-ask it. A ```done fence, and an ```awaiting on a
  // wait frizz itself will deliver, still stop the at-rest trigger.
  const limits = [
    maxRuns ? `at most ${maxRuns} time${maxRuns === 1 ? "" : "s"}` : null,
    forSeconds ? `for ${goalForLabel(forSeconds)}` : null,
  ].filter(Boolean)
  const bound = limits.length
    ? ` It is a bounded loop: ${limits.join(", and ")} — whichever comes first disarms it, and you will be told once.`
    : ""
  return (
    `Goal armed — frizz will send you this ${when}.${bound}${superseded}\n\n` +
    "Call this tool again with `action: \"stop\"` once the work it drives is finished — one left armed on " +
    "a finished thread wakes it forever. The human can also edit or switch it off in the thread footer. " +
    "Signing off with a ```done fence stops it too, but only when there is genuinely nothing left: it " +
    "files the thread away until the human sends more work."
  )
}

/** How a timer reads back to the worker: its id, when it fires, and enough of its text to tell two apart.
 * @param {{ id: string, fireAt: string, prompt: string }} t */
function timerLine(t) {
  const words = t.prompt.replace(/\s+/g, " ").trim()
  return `  ${t.id} — ${t.fireAt} — ${words.length > 72 ? `${words.slice(0, 72)}…` : words}`
}

/** @param {{ timers?: { id: string, fireAt: string, prompt: string }[] }|null} payload */
function armedList(payload) {
  const timers = payload?.timers ?? []
  if (!timers.length) return "No timers are armed on this thread."
  return `Armed timers (${timers.length}):\n${timers.map(timerLine).join("\n")}`
}

/** The `timer` handler: set / cancel / list this thread's ONE-OFF timers.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function timer(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "set" && action !== "cancel" && action !== "list") {
    throw new Error("`action` must be one of \"set\", \"cancel\" or \"list\"")
  }

  if (action === "list") {
    return armedList((await callRpc("listOwnThreadTimers", { slug }))?.result)
  }

  if (action === "cancel") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to cancel a timer — take it from `set`'s reply or from `action: \"list\"`")
    const result = (await callRpc("cancelOwnThreadTimer", { slug, id }))?.result
    const head = result?.cancelled
      ? `Timer ${id} cancelled — it will not fire.`
      : `No ARMED timer ${id} on this thread (it may have already fired, or already been cancelled).`
    return `${head}\n\n${armedList(result)}`
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required to set a timer — it is the text you will be sent when it fires")

  // Exactly one of the two ways to name the instant. Accepting both would mean silently preferring one,
  // and a worker that gave two different times meant something by each of them.
  const hasIn = args.in_seconds !== undefined && args.in_seconds !== null
  const hasAt = typeof args.at === "string" && args.at.trim() !== ""
  if (hasIn && hasAt) throw new Error("give `in_seconds` OR `at`, not both")
  if (!hasIn && !hasAt) throw new Error("give either `in_seconds` (fire N seconds from now) or `at` (an ISO-8601 instant)")

  const nowMs = Date.now()
  let fireMs
  if (hasIn) {
    const seconds = typeof args.in_seconds === "number" ? Math.round(args.in_seconds) : NaN
    if (!Number.isFinite(seconds)) throw new Error("`in_seconds` must be a number of seconds")
    if (seconds < TIMER_MIN_DELAY_SECONDS || seconds > TIMER_MAX_DELAY_SECONDS) {
      throw new Error(`\`in_seconds\` must be between ${TIMER_MIN_DELAY_SECONDS} and ${TIMER_MAX_DELAY_SECONDS} (thirty days)`)
    }
    fireMs = nowMs + seconds * 1000
  } else {
    fireMs = Date.parse(String(args.at))
    if (!Number.isFinite(fireMs)) throw new Error("`at` must be an ISO-8601 instant, e.g. `2026-08-04T15:00:00Z`")
    const delta = Math.round((fireMs - nowMs) / 1000)
    if (delta < TIMER_MIN_DELAY_SECONDS) {
      throw new Error(`\`at\` must be at least ${TIMER_MIN_DELAY_SECONDS}s in the future (it reads as ${delta}s from now)`)
    }
    if (delta > TIMER_MAX_DELAY_SECONDS) throw new Error("`at` must be within thirty days")
  }

  // ONE representation crosses the wire — the exact UTC instant — so the stored row, the trailer on the
  // delivered message and this reply all name the same string.
  const fireAt = new Date(fireMs).toISOString()
  const result = (await callRpc("setOwnThreadTimer", { slug, prompt, fireAt }))?.result
  const id = result?.id ?? "(unknown)"
  return (
    `Timer ${id} set for ${fireAt} (${Math.round((fireMs - nowMs) / 1000)}s from now). It fires ONCE and ` +
    "then is gone — it may reach you mid-turn, so receiving it does not mean you had stopped. Cancel it " +
    `with \`action: "cancel", id: "${id}"\` if it stops being useful.\n\n${armedList(result)}`
  )
}


/** How the armed PR-watcher set reads back, on every action, so a worker never needs a second call.
 * @param {{ watches?: Array<{id: string, target: string, github?: {checks: string, running: number, passed: number, failed: number, failing: string[], merge: string, state: string}}> }|undefined} result */
function armedPrWatchList(result) {
  // Only the PULL REQUESTS: the registry holds issues too (`watch_issue`), and each tool reads back its
  // own kind so a worker asking where its PRs stand is not told about an issue it registered elsewhere.
  const watches = (Array.isArray(result?.watches) ? result.watches : []).filter((w) => w.kind !== "issue")
  if (!watches.length) return "No pull requests are watched on this thread — nothing will wake you."
  const lines = watches.map((w) => {
    const g = w.github
    // The CHECK STATE rides the read-back because it is the reason a worker is listing at all: "where do
    // my PRs stand" is one call, not one per PR through `gh`.
    const state = !g
      ? "not polled yet"
      : g.state !== "open"
        ? g.state
        : g.checks === "passing" ? `checks green (${g.passed})`
        : g.checks === "failing" ? `checks FAILING${g.failing.length ? `: ${g.failing.join(", ")}` : ""}`
        : g.checks === "running" ? `checks running (${g.running} left)`
        : "no checks"
    return `  ${w.id}  ${w.target}  —  ${state}${g && g.state === "open" && g.merge === "mergeable" ? ", mergeable" : ""}`
  })
  return `Watched on this thread now:\n${lines.join("\n")}`
}

/** The issue twin of armedPrWatchList: the ISSUES watched on this thread, with each one's last-polled state.
 * @param {{ watches?: Array<{id: string, kind?: string, target: string, issue?: {state: string, stateReason?: string, title?: string, comments: number}}> }|undefined} result */
function armedIssueWatchList(result) {
  const watches = (Array.isArray(result?.watches) ? result.watches : []).filter((w) => w.kind === "issue")
  if (!watches.length) return "No issues are watched on this thread — nothing will wake you."
  const lines = watches.map((w) => {
    const i = w.issue
    const state = !i
      ? "not polled yet"
      : i.state === "closed"
        ? `closed${i.stateReason ? ` (${i.stateReason.replace(/_/g, " ")})` : ""}`
        : `open, ${i.comments} comment${i.comments === 1 ? "" : "s"}`
    return `  ${w.id}  ${w.target}${i?.title ? `  "${i.title}"` : ""}  —  ${state}`
  })
  return `Issues watched on this thread now:\n${lines.join("\n")}`
}

/** The armed watches on this thread, as the read-back prints them. */
function armedWatchList(result) {
  const watches = Array.isArray(result?.watches) ? result.watches : []
  if (!watches.length) return "No watches are armed on this thread — nothing here is holding it out of the queue."
  const lines = watches.map((w) => {
    const what = w.kind === "agent" ? "sub-agent" : "shell"
    // The LABEL is frizz's live reading, not a copy stored at registration — so it names the work as it
    // stands, and its ABSENCE means the target no longer resolves to anything running.
    const name = w.label ? `${w.label} (${w.target})` : w.target
    return `  ${w.id}  ${what}: ${name}  —  expires ${w.expiresAt}`
  })
  return `Armed on this thread now:\n${lines.join("\n")}`
}

/** The `watch` handler: register a wait on this thread's own running work.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watch(args) {
  const slug = threadSlug()
  const kind = typeof args.kind === "string" ? args.kind.trim() : ""
  if (kind !== "shell" && kind !== "agent") throw new Error("`kind` must be \"shell\" or \"agent\"")
  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the handle you were shown; `activity` prints them all")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION like `30m`, `2h` or `3d` (max 24h), never an instant")
  const result = (await callRpc("addOwnWatch", { slug, kind, target, for: forValue }))?.result
  const id = result?.id ?? "(unknown)"
  const head = result?.alreadyArmed
    ? `Already watching \`${target}\` as ${id} — nothing new was registered, and its original expiry stands.`
    : `Watching \`${target}\` as ${id}. Your thread is held out of the queue until it finishes, and the ` +
      "registration survives your turn ending, a compaction and a frizz restart."
  // A clamp is news here for the same reason it is on `watch_pr` — see that handler.
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`for: ${result.clampedFrom}\` WAS CAPPED at the 24h ceiling for a shell or a sub-agent — ` +
      "the expiry listed below is what you actually hold."
    : ""
  return (
    `${head}${clamped}\n\nWHEN \`for\` RUNS OUT the row is CANCELLED and you are woken to re-decide — register ` +
    `again if you still mean it.\n\nDROP IT the moment it stops mattering (\`unwatch\`, id \`${id}\`); ` +
    `you do NOT need to when the work simply finishes.\n\n${armedWatchList(result)}`
  )
}

/** The `unwatch` handler: withdraw one registered watch by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unwatch(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `watch` or from `activity`")
  // A PR, issue or timer id is not a `watch` row, and dropOwnWatch would report it "already settled"
  // while it stayed armed. The id prefix names its kind, so the one verb a worker reaches for routes it
  // to the call that really withdraws it.
  if (id.startsWith("prw_") || id.startsWith("isw_")) {
    const dropped = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    const kind = id.startsWith("isw_") ? "issue" : "pull request"
    const head = dropped?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED ${kind} watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${id.startsWith("isw_") ? armedIssueWatchList(dropped) : armedPrWatchList(dropped)}`
  }
  if (id.startsWith("tmr_")) {
    const cancelled = (await callRpc("cancelOwnThreadTimer", { slug, id }))?.result
    const head = cancelled?.cancelled
      ? `Timer ${id} cancelled — it will not fire.`
      : `No ARMED timer ${id} on this thread (it may have already fired, or already been cancelled).`
    return `${head}\n\n${armedList(cancelled)}`
  }
  const result = (await callRpc("dropOwnWatch", { slug, id }))?.result
  // A drop that matched nothing is reported rather than swallowed: the id was wrong, already settled, or
  // another thread's — and a worker that believes it withdrew a wait it still holds will rest on it.
  const head = result?.dropped
    ? `Watch ${id} dropped. It is no longer holding your thread, and it will not wake you.`
    : `No ARMED watch ${id} on this thread — it was already settled, or the id is not one of yours.`
  return `${head}\n\n${armedWatchList(result)}`
}

/** Read back what the human still owes an answer on, so a worker never needs a second call to find out.
 * @param {Record<string, unknown> | undefined} result @returns {string} */
function openQuestionList(result) {
  const open = Array.isArray(result?.open) ? result.open : []
  if (!open.length) return "Nothing else is open on this thread — the human owes you no answer."
  const lines = open.map((q) => `  ${q.id}  ${(q.spec?.question ?? "").split("\n")[0]}${q.repliedPast ? "  (set aside — withdrawn at your next rest unless you `keep` it)" : ""}`)
  return `Open on this thread now:\n${lines.join("\n")}`
}

/** The `ask` handler: register one or more questions the human owes an answer to.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function ask(args) {
  const slug = threadSlug()
  const questions = Array.isArray(args.questions) ? args.questions : []
  if (!questions.length) throw new Error("`questions` is required — at least one question to register")
  const result = (await callRpc("ask", { slug, questions }))?.result
  const registered = Array.isArray(result?.registered) ? result.registered : []
  const lines = registered.map((q) => `  ${q.id}  ${(q.spec?.question ?? "").split("\n")[0]}`)
  const head = registered.length === 1
    ? "Registered 1 question. It stays open until the human answers it."
    : `Registered ${registered.length} questions. They stay open until answered — the card sends every ` +
      "answer as one batch."
  return (
    `${head}\n${lines.join("\n")}\n\n` +
    "NOW WRITE YOUR FINAL MESSAGE, THEN REST. The card holds only the choice; it renders under that " +
    "message, which must carry everything the human needs to make it — what you found, the evidence, " +
    "and the answer to anything they asked — written out in full. \"The decision is in the card below\" " +
    "is not a handoff: a worker once ended a PR review on exactly that line, and the review itself " +
    "existed only in its thinking, which the human never sees. The human is not prompted until you " +
    "rest: while your turn runs the thread spins in the Active band, not the queue, and the card waits " +
    "unseen — so do no further WORK that does not depend on the answer, but never shorten the write-up " +
    "to rest sooner. The open question is your sign-off. If you are about to keep " +
    "going for long on your own best guess, `unask` it and decide instead. The answer arrives as its " +
    "own wake, restating what was asked.\n\n" +
    "WITHDRAW ONE THE MOMENT IT STOPS MATTERING (`unask`), above all if you work the answer out " +
    `yourself.\n\n${openQuestionList(result)}`
  )
}

/** The `unask` handler: withdraw one registered question by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unask(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `ask`")
  const result = (await callRpc("unask", { slug, id }))?.result
  // A withdrawal that matched nothing is reported rather than swallowed: the id was wrong, the human
  // already answered it, or it is another thread's — and a worker that believes it withdrew a question
  // the human is still looking at will get an answer it has stopped expecting.
  const head = result?.withdrawn
    ? `Question ${id} withdrawn. Its card is gone and the human will not be asked.`
    : `No OPEN question ${id} on this thread — it was already answered or dismissed, or the id is not one of yours.`
  return `${head}\n\n${openQuestionList(result)}`
}

/** The `keep` handler: opt a set-aside question back in, optionally reworded.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function keep(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `ask` or `activity`")
  const question = args.question && typeof args.question === "object" ? args.question : undefined
  const result = (await callRpc("keepQuestion", { slug, id, ...(question ? { question } : {}) }))?.result
  const head = result?.kept
    ? `Question ${id} kept${question ? ", reworded" : ""}. It holds your thread again, and its card renders at the bottom of your next handoff.`
    : `No OPEN question ${id} on this thread — it was already answered, dismissed or withdrawn, or the id is not one of yours.`
  return `${head}\n\n${openQuestionList(result)}`
}

/** The `schedule` handler: propose a recurring thread, or move one occurrence of an active one. The server
 *  builds the reply — the echo the worker relays verbatim — so this only shapes the request.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function schedule(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  const actions = ["create", "dry_run", "update", "list", "pause", "skip_next", "move_next"]
  if (!actions.includes(action)) throw new Error(`\`action\` must be one of ${actions.map((a) => `"${a}"`).join(", ")}`)
  /** @param {string} key */
  const text = (key) => (typeof args[key] === "string" && args[key].trim() ? args[key].trim() : undefined)
  /** @type {Record<string, unknown>} */
  const body = { action, slug }
  if (action !== "list" && action !== "create" && action !== "dry_run") {
    const id = text("id")
    if (!id) throw new Error("`id` is required — take the `sch_…` id from `create`'s reply or from `action: \"list\"`")
    body.id = id
  }
  if (action === "create" || action === "dry_run" || action === "update") {
    for (const key of ["title", "prompt", "when", "rrule", "dtstart", "tz", "condition", "model", "effort", "backend"]) {
      const value = text(key)
      if (value !== undefined) body[key] = value
    }
    if (action !== "update") {
      for (const key of ["title", "prompt", "when", "rrule", "dtstart"]) {
        if (body[key] === undefined) throw new Error(`\`${key}\` is required to ${action === "create" ? "create" : "dry-run"} a schedule`)
      }
      // Required with no default, like spawn_thread: every run is a paid agent session, and a defaulted
      // model is the cheap one picked by nobody.
      if (body.model === undefined) throw new Error("`model` is required — choose it for what ONE run must do (claude: opus/sonnet/haiku; codex: a model id with backend: \"codex\"). There is no default.")
      if (body.effort === undefined) throw new Error("`effort` is required — choose it for what one run must do (low/medium/high/xhigh/max). There is no default.")
    }
  }
  if (action === "skip_next") {
    const reason = text("reason")
    if (reason) body.reason = reason
  }
  if (action === "move_next") {
    const to = text("to")
    if (!to) throw new Error("`to` is required — the new start, as a local time in the schedule's zone (`2026-10-15T10:00`) or an ISO instant")
    body.to = to
  }
  const result = (await callRpc("ownSchedule", body))?.result
  if (typeof result?.text !== "string") throw new Error(`ownSchedule returned no reply: ${JSON.stringify(result)?.slice(0, 300)}`)
  return result.text
}

/** The `done` handler: declare the effort finished, or report exactly what refuses to let it.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function done(args) {
  const slug = threadSlug()
  const body = typeof args.body === "string" ? args.body.trim() : ""
  if (!body) throw new Error("`body` is required — the write-up the human reads on the card")
  const quiet = args.quiet === true
  const result = (await callRpc("markOwnDone", { slug, body, ...(quiet ? { quiet: true } : {}) }))?.result
  if (result?.done && quiet) {
    return (
      "Marked done QUIETLY. This run is filed under Done, out of the human's queue, and your body's first " +
      "line is its line in the schedule's history. End your turn now."
    )
  }
  if (result?.done) {
    return (
      "Marked done. Your thread cards as a checked success in the human's queue and stays there until " +
      "they archive it.\n\nNOTHING WAS CLOSED, HIDDEN OR ARCHIVED — if there is more to say, say it in " +
      "your final message; if more work appears, keep going and call this again."
    )
  }
  // REFUSED, with everything that refuses it named by id, so the next move is a tool call and not a
  // guess. Reported as an ordinary result rather than thrown: this is a gate doing its job, not a fault.
  const questions = (result?.blockingQuestions ?? []).map((q) => `  ${q.id}  ${(q.question ?? "").split("\n")[0]}`)
  const watches = (result?.blockingWatches ?? []).map((w) => `  ${w.id}  ${w.what}`)
  const parts = ["NOT marked done. This thread still holds work open."]
  if (questions.length) {
    parts.push(
      `${questions.length} question${questions.length === 1 ? "" : "s"} the human has not answered:\n${questions.join("\n")}\n` +
      "Each one dies unread with a done card. Decide it yourself and withdraw it (`unask`), or leave it " +
      "open and keep working until it is answered.",
    )
  }
  if (watches.length) {
    parts.push(
      `${watches.length} registration${watches.length === 1 ? "" : "s"} still armed:\n${watches.join("\n")}\n` +
      "A live wait means the thing you were waiting for has not happened. Wait for it, or drop the ones " +
      "that stopped mattering (`unwatch`, or `watch_pr` / `watch_issue` with `action: \"drop\"`, or `timer` cancel).",
    )
  }
  parts.push("There is no force parameter. Resolve them and call `done` again.")
  return parts.join("\n\n")
}

/** The `watch_pr` handler: register, withdraw, or read back this thread's PR watchers.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watchPr(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedPrWatchList((await callRpc("listOwnPrWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a watcher — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    // A drop that matched nothing is reported rather than swallowed: the id was wrong, already settled,
    // or another thread's — and a worker that believes it withdrew a wait it still holds will rest.
    const head = result?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${armedPrWatchList(result)}`
  }

  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the pull request, as `owner/repo#123` or a PR URL")
  const result = (await callRpc("addOwnPrWatch", { slug, target, for: typeof args.for === "string" ? args.for.trim() : "" }))?.result
  const id = result?.id ?? "(unknown)"
  const ref = result?.target ?? target
  const until = result?.expiresAt ? ` until ${result.expiresAt}` : ""
  const head = result?.alreadyArmed
    ? `Already watching ${ref} as ${id}${until} — nothing new was registered, its original expiry stands, and you will be woken once per event.`
    : `Watching ${ref} as ${id}${until}. Frizz wakes you when CI passes or fails and on every later ` +
      "review or comment, and the registration survives your turn ending, a compaction and a frizz restart."
  // A CLAMP IS NEWS. Silently handing back less coverage than was asked for is how a worker comes to
  // rest believing it is watched for a year when it is watched for one day.
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`for: ${result.clampedFrom}\` WAS CAPPED at the ceiling — the expiry above is what you ` +
      "actually hold. Nothing else about the watcher changed."
    : ""
  return (
    `${head}${clamped}\n\nNAME IT IN YOUR \`\`\`awaiting FENCE TOO (\`prs: [${ref}]\`) — the watcher does the ` +
    `waking, the fence is what lets you come to rest and shows the human what you are waiting for.\n\n` +
    `DROP IT when it stops mattering (\`action: "drop", id: "${id}"\`).\n\n${armedPrWatchList(result)}`
  )
}

/** The `watch_issue` handler: register, withdraw, or read back this thread's issue watchers. The same
 * three RPCs as `watchPr` — one registry — with `kind: "issue"` on the add.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watchIssue(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedIssueWatchList((await callRpc("listOwnPrWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a watcher — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    const head = result?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${armedIssueWatchList(result)}`
  }

  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the issue, as `owner/repo#123` or a GitHub issue URL")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION like `3d`, `30d` or `180d` (max 365d), never an instant")
  const result = (await callRpc("addOwnPrWatch", { slug, target, for: forValue, kind: "issue" }))?.result
  const id = result?.id ?? "(unknown)"
  const ref = result?.target ?? target
  const until = result?.expiresAt ? ` until ${result.expiresAt}` : ""
  const head = result?.alreadyArmed
    ? `Already watching ${ref} as ${id}${until} — nothing new was registered, its original expiry stands, and you will be woken once per event.`
    : `Watching issue ${ref} as ${id}${until}. Frizz wakes you on every later comment, on a label or ` +
      "assignee change, and when the issue closes; the registration survives your turn ending, a compaction and a frizz restart."
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`for: ${result.clampedFrom}\` WAS CAPPED at the ceiling — the expiry above is what you ` +
      "actually hold. Nothing else about the watcher changed."
    : ""
  return (
    `${head}${clamped}\n\nNAME IT IN YOUR \`\`\`awaiting FENCE TOO (\`issues: [${ref}]\`) — the watcher does the ` +
    `waking, the fence is what lets you come to rest and shows the human what you are waiting for.\n\n` +
    `DROP IT when it stops mattering (\`action: "drop", id: "${id}"\`).\n\n${armedIssueWatchList(result)}`
  )
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "frizz", version: "0.1.0" },
      })
      return
    }
    case "notifications/initialized":
    case "initialized":
      return // notification — no reply
    case "ping":
      if (!isNotification) reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: TOOLS })
      return
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : ""
      const handler = HANDLERS[name]
      if (!handler) {
        replyError(id, -32602, `unknown tool: ${params?.name}`)
        return
      }
      try {
        replyTool(id, await handler(params?.arguments ?? {}))
      } catch (err) {
        replyTool(id, `\`${name}\` failed: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      return
    }
    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
      return
  }
}

// NDJSON reader: buffer stdin, dispatch each complete line. Messages never contain raw newlines.
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore unparseable lines
    }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
