import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseCodexQuotaFromRollout, parseCodexQuotaFromRateLimits, readCodexQuota, resetCodexQuotaMemo } from "./codex-quota.ts"
import { parseClaudeUsage, parseClaudeUsageOutput, tokenFromCredentialsJson, readClaudeQuota, refreshClaudeQuotaInBackground, claudeQuotaRefreshSettled } from "./claude-quota.ts"

// ---- Codex rollout parsing ----

test("codex: live event_msg-wrapped rate_limits (payload.rate_limits)", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-15T10:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1783730191 },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1784316991 },
      },
    },
  })
  const q = parseCodexQuotaFromRollout(line + "\n")
  assert.equal(q?.status, "ok")
  assert.equal(q?.planType, "pro")
  assert.deepEqual(q?.windows.map((w) => [w.key, w.usedPercent]), [["5h", 12.5], ["weekly", 40]])
})

test("codex: flattened top-level rate_limits (exec/fixture shape)", () => {
  const line = JSON.stringify({
    type: "token_count",
    info: {},
    rate_limits: {
      plan_type: "pro",
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 2 },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 2)
})

test("codex: window labeled by window_minutes, not primary/secondary name (real single-window case)", () => {
  // Real observed: `primary` carries the WEEKLY window (10080), `secondary` is null.
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: { plan_type: "pro", primary: { used_percent: 88, window_minutes: 10080, resets_at: 9 }, secondary: null },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 1)
  assert.equal(q?.windows[0]!.key, "weekly")
  assert.equal(q?.windows[0]!.usedPercent, 88)
})

test("codex: last token_count wins; junk lines skipped", () => {
  const stale = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } })
  const fresh = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 55, window_minutes: 300 } } } })
  const raw = [stale, "not json {", JSON.stringify({ type: "response_item" }), fresh].join("\n")
  const q = parseCodexQuotaFromRollout(raw)
  assert.equal(q?.windows[0]!.usedPercent, 55)
})

test("codex: no rate_limits anywhere → undefined", () => {
  assert.equal(parseCodexQuotaFromRollout(JSON.stringify({ type: "response_item" })), undefined)
  assert.equal(parseCodexQuotaFromRollout(""), undefined)
})

// ---- Codex live app-server (account/rateLimits/read) parsing ----

test("codex live: camelCase rateLimits → windows labeled by windowDurationMins", () => {
  // Captured verbatim from codex-cli 0.146.0 (fields frizz ignores trimmed).
  const q = parseCodexQuotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786130265 },
      secondary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1786100000 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
    },
    rateLimitsByLimitId: { codex_bengalfox: { primary: { usedPercent: 99, windowDurationMins: 10080 } } },
  })
  assert.equal(q?.status, "ok")
  assert.equal(q?.planType, "pro")
  // Per-model `rateLimitsByLimitId` is ignored — only the account aggregate is shown.
  assert.deepEqual(q?.windows.map((w) => [w.key, w.usedPercent]), [["weekly", 0], ["5h", 12.5]])
  assert.equal(q?.windows[0]!.resetsAt, 1786130265)
})

test("codex live: 0% used is a real reading, not a missing one", () => {
  // The exact regression: a freshly-switched account reads 0 and must NOT be discarded as falsy.
  const q = parseCodexQuotaFromRateLimits({
    rateLimits: { planType: "pro", primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1 }, secondary: null },
  })
  assert.equal(q?.status, "ok")
  assert.equal(q?.windows.length, 1)
  assert.equal(q?.windows[0]!.usedPercent, 0)
})

test("codex live: null/absent windows → undefined so the caller falls back", () => {
  // Real shape seen on a `limit_id:"premium"` session: both windows null.
  assert.equal(parseCodexQuotaFromRateLimits({ rateLimits: { limitId: "premium", primary: null, secondary: null } }), undefined)
  assert.equal(parseCodexQuotaFromRateLimits({ rateLimits: {} }), undefined)
  assert.equal(parseCodexQuotaFromRateLimits({}), undefined)
  assert.equal(parseCodexQuotaFromRateLimits(undefined), undefined)
  assert.equal(parseCodexQuotaFromRateLimits("nope"), undefined)
})

test("codex live: snake_case rollout spelling is NOT accepted here", () => {
  // The two sources genuinely differ; accepting both in one reader would hide a protocol change.
  assert.equal(
    parseCodexQuotaFromRateLimits({ rateLimits: { primary: { used_percent: 40, window_minutes: 10080 } } }),
    undefined,
  )
})

test("codex: a failed live read degrades to the rollout tail, labeled as unconfirmed", async () => {
  // `codexBin` points at a binary that cannot answer, so the live path resolves undefined.
  const dir = await mkdtemp(join(tmpdir(), "frizz-codex-quota-"))
  try {
    const day = join(dir, "sessions", "2026", "07", "31")
    await mkdir(day, { recursive: true })
    await writeFile(
      join(day, "rollout-2026-07-31T00-00-00-aaaa.jsonl"),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { plan_type: "pro", primary: { used_percent: 99, window_minutes: 10080, resets_at: 7 } } },
      }) + "\n",
    )
    resetCodexQuotaMemo()
    const q = await readCodexQuota(dir, join(dir, "definitely-not-a-real-codex-binary"))
    assert.equal(q.status, "ok")
    assert.equal(q.windows[0]!.usedPercent, 99)
    assert.match(q.detail ?? "", /last local session/i)
  } finally {
    resetCodexQuotaMemo()
    await rm(dir, { recursive: true, force: true })
  }
})

test("codex: a failed live read with no rollouts stays a clean unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frizz-codex-quota-"))
  try {
    resetCodexQuotaMemo()
    const q = await readCodexQuota(dir, join(dir, "definitely-not-a-real-codex-binary"))
    assert.equal(q.status, "unavailable")
    assert.deepEqual(q.windows, [])
  } finally {
    resetCodexQuotaMemo()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- Claude usage endpoint parsing ----

test("claude: five_hour + seven_day utilization → windows", () => {
  const q = parseClaudeUsage(
    { five_hour: { utilization: 34, reset_at: "2026-07-15T18:00:00Z" }, seven_day: { utilization: 61, reset_at: "2026-07-18T00:00:00Z" } },
    "max",
  )
  assert.equal(q.status, "ok")
  assert.equal(q.planType, "max")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 34], ["weekly", 61]])
  assert.equal(typeof q.windows[0]!.resetsAt, "number")
})

test("claude: surfaces model-specific weekly caps (opus/sonnet) when present", () => {
  const q = parseClaudeUsage({
    five_hour: { utilization: 10, reset_at: "2026-07-15T18:00:00Z" },
    seven_day: { utilization: 40, reset_at: "2026-07-18T00:00:00Z" },
    seven_day_opus: { utilization: 91, reset_at: "2026-07-18T00:00:00Z" },
  })
  assert.deepEqual(q.windows.map((w) => w.key), ["5h", "weekly", "weekly-opus"])
  // The binding limit (opus 91% used) is the highest usedPercent → the chip's "tightest" pick.
  assert.equal(Math.max(...q.windows.map((w) => w.usedPercent)), 91)
})

test("claude: modern limits[] body (live 2026-07 shape) — session + model-scoped weekly", () => {
  // Captured verbatim (percents aside) from the live endpoint on a Fable plan: seven_day is null and
  // the windows ride in limits[], the weekly scoped to a model display name.
  const q = parseClaudeUsage({
    five_hour: { utilization: 40, resets_at: "2026-07-24T03:00:00.417680+00:00", limit_dollars: null },
    seven_day: null,
    seven_day_opus: null,
    limits: [
      { kind: "session", group: "session", percent: 40, severity: "normal", resets_at: "2026-07-24T03:00:00.417680+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 49, severity: "normal", resets_at: "2026-07-27T08:00:00.417999+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
    ],
  })
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.label, w.usedPercent]), [
    ["5h", "5h", 40],
    ["weekly-fable", "Fable wk", 49],
  ])
  assert.equal(q.windows[0]?.resetsAt, Math.round(Date.parse("2026-07-24T03:00:00.417680+00:00") / 1000))
  assert.equal(q.windows[1]?.resetsAt, Math.round(Date.parse("2026-07-27T08:00:00.417999+00:00") / 1000))
})

test("claude: legacy body with snake resets_at still parses; limits[] wins on key collisions", () => {
  const q = parseClaudeUsage({
    five_hour: { utilization: 12, resets_at: "2026-07-24T03:00:00Z" },
    limits: [{ kind: "session", group: "session", percent: 14, resets_at: "2026-07-24T04:00:00Z" }],
  })
  // limits[] is authoritative for the same window key.
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 14]])
})

test("claude: malformed / empty body → unavailable, never throws", () => {
  assert.equal(parseClaudeUsage(null).status, "unavailable")
  assert.equal(parseClaudeUsage({}).status, "unavailable")
  assert.equal(parseClaudeUsage({ five_hour: { reset_at: "x" } }).status, "unavailable")
})

// ---- Credential blob parsing (same shape whether it comes from ~/.claude/.credentials.json OR the
// macOS Keychain "Claude Code-credentials" generic password — `security -w` prints this exact blob). ----

test("claude creds: nested claudeAiOauth.accessToken (current shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } })), "tok-abc")
})

test("claude creds: flat access_token (drifted/older shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ access_token: "tok-flat" })), "tok-flat")
})

test("claude creds: garbage / empty / no token → undefined, never throws", () => {
  assert.equal(tokenFromCredentialsJson("not json {"), undefined)
  assert.equal(tokenFromCredentialsJson("null"), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "" } })), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ other: 1 })), undefined)
})

// ---- Claude Code `/usage` parsing + cross-window cache ----

const usageText = [
  "You are currently using your subscription to power your Claude Code usage",
  "Current session: 20% used · resets 4pm",
  "Current week (all models): 44% used · resets Thu",
  "Current week (Sonnet only): 61% used · resets Thu",
].join("\n")
const usageEnvelope = JSON.stringify({ type: "result", subtype: "success", result: usageText })

test("claude CLI usage: parses independent session, weekly, and model-scoped windows", () => {
  const now = new Date("2026-07-22T15:00:00").getTime()
  const q = parseClaudeUsageOutput(usageText, now)
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.label, w.usedPercent]), [
    ["5h", "5h", 20],
    ["weekly", "Weekly", 44],
    ["weekly-sonnet", "Sonnet wk", 61],
  ])
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2026-07-22T16:00:00").getTime() / 1000))
})

test("claude CLI usage: parses the JSON result envelope and rejects cost-only signed-out output", () => {
  assert.equal(parseClaudeUsageOutput(usageEnvelope).status, "ok")
  const missing = parseClaudeUsageOutput(JSON.stringify({ result: "Total cost: $0.00\nUsage: 0 input" }))
  assert.equal(missing.status, "unavailable")
  assert.equal(missing.detail, "Claude Code did not report subscription quota")
})

test("claude CLI usage: parses the live '<Mon> <D> at <clock> (<tz>)' reset labels", () => {
  const now = new Date("2026-07-23T10:30:00").getTime()
  const q = parseClaudeUsageOutput(
    [
      "Current session: 17% used · resets Jul 23 at 3pm (America/Los_Angeles)",
      "Current week (Fable): 45% used · resets Jul 27 at 12:59am (America/Los_Angeles)",
    ].join("\n"),
    now,
  )
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 17], ["weekly-fable", 45]])
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2026-07-23T15:00:00").getTime() / 1000))
  assert.equal(q.windows[1]?.resetsAt, Math.round(new Date("2026-07-27T00:59:00").getTime() / 1000))
})

test("claude CLI usage: a year-less date label crossing New Year resolves forward", () => {
  const now = new Date("2026-12-30T10:00:00").getTime()
  const q = parseClaudeUsageOutput("Current session: 5% used · resets Jan 2 at 3pm (America/Los_Angeles)", now)
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2027-01-02T15:00:00").getTime() / 1000))
})

async function withCache(run: (cacheDir: string) => Promise<void>) {
  const cacheDir = await mkdtemp(join(tmpdir(), "frizz-quota-test-"))
  try {
    await run(cacheDir)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
}

// Pins a test to the CLI fallback path (no credential → the endpoint is never attempted).
const noToken = async () => undefined

function usageResponse(status: number, body?: unknown): typeof fetch {
  return (async () => new Response(body === undefined ? "" : JSON.stringify(body), { status })) as unknown as typeof fetch
}

const endpointBody = {
  plan_type: "max",
  five_hour: { utilization: 30, reset_at: "2026-07-23T22:00:00Z" },
  seven_day: { utilization: 47, reset_at: "2026-07-27T08:00:00Z" },
}

test("claude quota: the OAuth endpoint is the primary source — the CLI is never spawned on a healthy read", () => withCache(async (cacheDir) => {
  let cliCalls = 0
  const q = await readClaudeQuota("claude-test", {
    cacheDir,
    now: () => 0,
    readToken: async () => "tok-live",
    fetchImpl: usageResponse(200, endpointBody),
    execUsage: async () => { cliCalls++; return usageEnvelope },
  })
  assert.equal(q.status, "ok")
  assert.equal(q.planType, "max")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 30], ["weekly", 47]])
  assert.equal(cliCalls, 0)
}))

test("claude quota: a rejected token (401) falls back to the CLI, which owns refresh", () => withCache(async (cacheDir) => {
  let cliCalls = 0
  const q = await readClaudeQuota("claude-test", {
    cacheDir,
    now: () => 0,
    readToken: async () => "tok-expired",
    fetchImpl: usageResponse(401),
    execUsage: async () => { cliCalls++; return usageEnvelope },
  })
  assert.equal(q.status, "ok")
  assert.equal(cliCalls, 1)
}))

test("claude quota: a 429 backs off — no CLI hammering, last good reading served", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 0, execUsage: async () => usageEnvelope })
  let cliCalls = 0
  // The heartbeat's refresh meets the 429: it spends no CLI process and keeps the reading.
  await refreshClaudeQuotaInBackground("claude-test", {
    cacheDir,
    now: () => 4 * 60_000,
    readToken: async () => "tok-live",
    fetchImpl: usageResponse(429),
    execUsage: async () => { cliCalls++; return usageEnvelope },
  })
  await claudeQuotaRefreshSettled()
  const q = await readClaudeQuota("claude-test", { cacheDir, readToken: async () => "tok-live", now: () => 4 * 60_000 })
  assert.equal(q.status, "ok")
  assert.equal(q.windows[0]?.usedPercent, 20)
  assert.equal(cliCalls, 0)
}))

test("claude quota: a manual recheck during a 429 reads through the CLI and keeps the endpoint's deadline", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 0, execUsage: async () => usageEnvelope })
  let fetches = 0
  let cliCalls = 0
  const deps = {
    cacheDir,
    readToken: async () => "tok-live",
    fetchImpl: (async () => { fetches++; return new Response("", { status: 429 }) }) as unknown as typeof fetch,
    execUsage: async () => { cliCalls++; return "Current session: 55% used\nCurrent week (all models): 3% used" },
  }
  // The refresh that meets the 429 falls through to the CLI at once rather than serving the old reading.
  const fresh = await readClaudeQuota("claude-test", { ...deps, now: () => 4 * 60_000 }, { force: true })
  assert.equal(fresh.windows[0]?.usedPercent, 55)
  assert.equal(fresh.detail, undefined)
  assert.deepEqual([fetches, cliCalls], [1, 1])
  // Inside the window a second press goes straight to the CLI, never the endpoint…
  await readClaudeQuota("claude-test", { ...deps, now: () => 5 * 60_000 }, { force: true })
  assert.deepEqual([fetches, cliCalls], [1, 2])
  // …and the heartbeat, past the fresh reading's TTL, still leaves the refusing endpoint alone.
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 8 * 60_000 })
  await claudeQuotaRefreshSettled()
  assert.deepEqual([fetches, cliCalls], [1, 2])
}))

test("claude quota: a 429's retry-after is honored by every caller until it passes, then cleared by a success", () => withCache(async (cacheDir) => {
  let fetches = 0
  let status = 429
  const fetchImpl = (async () => {
    fetches++
    return status === 429
      ? new Response("", { status: 429, headers: { "retry-after": "139" } })
      : new Response(JSON.stringify(endpointBody), { status: 200 })
  }) as unknown as typeof fetch
  // The CLI fails too, so a manual recheck inside the window can only serve the labeled cached reading.
  const deps = { cacheDir, readToken: async () => "tok-live", fetchImpl, execUsage: async () => { throw new Error("CLI unavailable") } }
  await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 0, execUsage: async () => usageEnvelope })

  // The recheck that learns the deadline: 3m in, the endpoint answers 429 + retry-after 139s.
  const refused = await readClaudeQuota("claude-test", { ...deps, now: () => 3 * 60_000 }, { force: true })
  assert.equal(refused.detail, "Next refresh in 3m · last updated 3m ago")
  assert.equal(fetches, 1)

  // Inside the window nothing asks again — not a forced recheck, not the heartbeat, not a stale read.
  const again = await readClaudeQuota("claude-test", { ...deps, now: () => 4 * 60_000 }, { force: true })
  assert.equal(again.detail, "Next refresh in 2m · last updated 4m ago")
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 4 * 60_000 })
  assert.equal((await readClaudeQuota("claude-test", { ...deps, now: () => 5 * 60_000 })).detail, undefined)
  await claudeQuotaRefreshSettled()
  assert.equal(fetches, 1)

  // Past it, the heartbeat refreshes; the success clears the deadline, so a recheck is live again.
  status = 200
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 3 * 60_000 + 140_000 })
  await claudeQuotaRefreshSettled()
  assert.equal(fetches, 2)
  const fresh = await readClaudeQuota("claude-test", { ...deps, now: () => 6 * 60_000 }, { force: true })
  assert.equal(fresh.detail, undefined)
  assert.equal(fresh.windows[0]?.usedPercent, 30)
  assert.equal(fetches, 3)
}))

test("claude quota: the heartbeat leaves a reading inside its TTL alone", () => withCache(async (cacheDir) => {
  let fetches = 0
  const fetchImpl = (async () => { fetches++; return new Response(JSON.stringify(endpointBody), { status: 200 }) }) as unknown as typeof fetch
  const deps = { cacheDir, readToken: async () => "tok-live", fetchImpl }
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 0 })
  await claudeQuotaRefreshSettled()
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 30_000 })
  await claudeQuotaRefreshSettled()
  assert.equal(fetches, 1)
}))

test("claude quota: healthy result is shared, while force performs a real recheck", () => withCache(async (cacheDir) => {
  let calls = 0
  const execUsage = async () => {
    calls++
    return usageEnvelope
  }
  assert.equal((await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 0, execUsage })).status, "ok")
  // A second read comfortably within the 60s healthy TTL is served from the shared cache, no new call.
  assert.equal((await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 30_000, execUsage })).status, "ok")
  assert.equal(calls, 1)
  await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 30_001, execUsage }, { force: true })
  assert.equal(calls, 2)
}))

test("claude quota: the proactive heartbeat warms the shared cache off the endpoint, no browser read, no CLI", () => withCache(async (cacheDir) => {
  let cliCalls = 0
  let percent = 30
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ plan_type: "max", five_hour: { utilization: percent, reset_at: "2026-07-23T22:00:00Z" } }), { status: 200 })) as unknown as typeof fetch
  const deps = { cacheDir, readToken: async () => "tok-live", fetchImpl, execUsage: async () => { cliCalls++; return usageEnvelope } }

  // No foreground read has happened — the cache is cold. The heartbeat alone must populate it.
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 0 })
  await claudeQuotaRefreshSettled()
  const warmed = await readClaudeQuota("claude-test", { ...deps, now: () => 0 })
  assert.equal(warmed.status, "ok")
  assert.equal(warmed.windows[0]?.usedPercent, 30)

  // The value moves; a heartbeat past the 2m TTL rewrites the cache so the next read is fresh — all
  // from the endpoint, never spawning the CLI.
  percent = 85
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 121_000 })
  await claudeQuotaRefreshSettled()
  const refreshed = await readClaudeQuota("claude-test", { ...deps, now: () => 121_000 })
  assert.equal(refreshed.windows[0]?.usedPercent, 85)
  assert.equal(cliCalls, 0)
}))

test("claude quota: concurrent project windows collapse onto one Claude Code invocation", () => withCache(async (cacheDir) => {
  let calls = 0
  const execUsage = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 100))
    return usageEnvelope
  }
  const results = await Promise.all([
    readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 1_000, execUsage }),
    readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 1_000, execUsage }),
    readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 1_000, execUsage }),
  ])
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.status === "ok"))
}))

test("claude quota: an expired reading is served instantly while a background refresh updates the cache", () => withCache(async (cacheDir) => {
  let calls = 0
  const execUsage = async () => {
    calls++
    return JSON.stringify({ type: "result", subtype: "success", result: `Current session: ${calls === 1 ? 20 : 55}% used · resets 4pm` })
  }
  await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 0, execUsage })
  assert.equal(calls, 1)
  // TTL expired: the poll gets the stale-but-recent reading back immediately (no CLI wait on the
  // request path) and the refresh happens behind it.
  const swr = await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 4 * 60_000, execUsage })
  assert.equal(swr.status, "ok")
  assert.equal(swr.windows[0]?.usedPercent, 20)
  assert.equal(swr.detail, undefined)
  await claudeQuotaRefreshSettled()
  assert.equal(calls, 2)
  const after = await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 4 * 60_000 + 1, execUsage })
  assert.equal(after.windows[0]?.usedPercent, 55)
  assert.equal(calls, 2)
}))

test("claude quota: a meaningfully old reading served via stale-while-revalidate says so", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 0, execUsage: async () => usageEnvelope })
  const swr = await readClaudeQuota(
    "claude-test",
    { cacheDir, readToken: noToken, now: () => 15 * 60_000, execUsage: async () => { throw new Error("CLI down") } },
  )
  assert.equal(swr.status, "ok")
  assert.equal(swr.detail, "Refreshing · last updated 15m ago")
  await claudeQuotaRefreshSettled()
}))

test("claude quota: a failed refresh retains the last good reading with an honest stale label", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: noToken, now: () => 0, execUsage: async () => usageEnvelope })
  const stale = await readClaudeQuota(
    "claude-test",
    { cacheDir, readToken: noToken, now: () => 4 * 60_000, execUsage: async () => { throw new Error("CLI failed") } },
    { force: true },
  )
  assert.equal(stale.status, "ok")
  assert.equal(stale.windows[0]?.usedPercent, 20)
  assert.equal(stale.detail, "Could not refresh · last updated 4m ago")
}))
