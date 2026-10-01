import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureLaunchEnvironment, inheritWorkerEnvironment, isFrizzInternalEnvKey, launchEnvironment } from "./worker-env.ts"

// The rule is a PREFIX, not a list, and that is the point: the three allowlists this replaced drifted
// apart precisely because each was hand-kept. A prefix cannot drift — a new FRIZZ_ variable is denied
// the day someone adds it, without anyone remembering to update anything.
test("isFrizzInternalEnvKey denies frizz's control plane by prefix and nothing else", () => {
  for (const key of [
    "FRIZZ_CLAUDE_BROKER",           // a daemon's entire config as JSON
    "FRIZZ_CODEX_APP_SERVER_DAEMON", // the codex twin of it
    "FRIZZ_LAUNCH_OWNER_TOKEN",      // which server owns which project
    "FRIZZ_SERVER_LOCK",
    "FRIZZ_THREAD",               // hook identity — re-added per thread by workerEnv
    "FRIZZ_PERM_DIR",
    "FRIZZ_",                        // degenerate, still ours
  ]) assert.equal(isFrizzInternalEnvKey(key), true, `${key} must not be inherited`)

  // Everything the operator legitimately set, INCLUDING the ones the old allowlists dropped and the
  // credentials it deliberately withheld. Withholding those was never a boundary — a worker has a
  // shell and can read ~/.aws/credentials — and the cost was builds inside a worker diverging from the
  // same build in the operator's own terminal.
  for (const key of [
    "PATH", "HOME", "SHELL", "LANG",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    "SSH_AUTH_SOCK", "GPG_TTY", "GIT_CONFIG_GLOBAL",
    "NVM_DIR", "GOPATH", "CARGO_HOME", "JAVA_HOME", "PYENV_ROOT",
    "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY",
    "MYFRIZZ_TOKEN",  // contains "FRIZZ" but is not OURS — the prefix must anchor at the start
    "XFRIZZ_",
  ]) assert.equal(isFrizzInternalEnvKey(key), false, `${key} must be inherited`)
})

test("inheritWorkerEnvironment copies everything but frizz's own, and drops undefined", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.test:8080",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GITHUB_TOKEN: "gh-token",
    FRIZZ_CLAUDE_BROKER: '{"socketPath":"/tmp/s"}',
    FRIZZ_THREAD: "some-other-thread",
    UNSET: undefined,
  }
  assert.deepEqual(inheritWorkerEnvironment(source), {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.test:8080",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GITHUB_TOKEN: "gh-token",
  })

  // A snapshot, not a live view: the child must not observe later mutations of the caller's env.
  const mutable: NodeJS.ProcessEnv = { A: "1" }
  const snapshot = inheritWorkerEnvironment(mutable)
  mutable.B = "2"
  assert.deepEqual(snapshot, { A: "1" })
  assert.notEqual(snapshot as unknown, mutable as unknown)
})

// The callers all merge their per-thread `workerEnv` ON TOP of this, which is what puts back the
// handful of FRIZZ_ variables a worker genuinely needs — with THIS thread's values rather than the
// server's. Pinned here because the ordering is the whole reason denying the prefix is safe.
test("a caller's per-thread overrides restore the frizz vars a worker needs", () => {
  const server: NodeJS.ProcessEnv = { FRIZZ_THREAD: "server-thread", FRIZZ_PERM_DIR: "/server/perm", PATH: "/usr/bin" }
  const merged: Record<string, string> = { ...inheritWorkerEnvironment(server), FRIZZ_THREAD: "my-thread", FRIZZ_PERM_DIR: "/my/perm" }
  assert.equal(merged.FRIZZ_THREAD, "my-thread", "the thread's own identity, never the server's")
  assert.equal(merged.FRIZZ_PERM_DIR, "/my/perm")
  assert.equal(merged.PATH, "/usr/bin")
})

// ── What frizz's own runtime wrote is not what the operator exported ──────────────────────────────
// 2026-09-30: every worker of a `nub run dev` frizz started with NODE_ENV=development, written into the
// dev server's process.env by Vite's resolveConfig, and `next build` inside a worker failed on it. The
// fix resets the keys Vite writes to a snapshot taken at module load. These run in a CHILD process
// because the snapshot is per process and taken at import, so each case needs its own launch env.

const WORKER_ENV_URL = new URL("./worker-env.ts", import.meta.url).href

/** Launch a node process with `env`, import worker-env.ts, run `body`, and return what it printed. */
function inChild(env: Record<string, string | undefined>, body: string, cwd?: string): Record<string, unknown> {
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value
  const script = `import { inheritWorkerEnvironment, launchEnvironment } from ${JSON.stringify(WORKER_ENV_URL)}\n${body}`
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: childEnv, cwd, encoding: "utf8" })
  assert.equal(result.status, 0, `child failed: ${result.stderr}`)
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
}

const REPORT = `console.log(JSON.stringify({
  live: process.env.NODE_ENV ?? null,
  worker: inheritWorkerEnvironment().NODE_ENV ?? null,
  workerFromExplicitSource: inheritWorkerEnvironment({ ...process.env }).NODE_ENV ?? null,
  daemon: launchEnvironment().NODE_ENV ?? null,
  daemonKeepsControlPlane: launchEnvironment().FRIZZ_PROBE ?? null,
}))`

test("a NODE_ENV written after launch never reaches a worker or a daemon", () => {
  const out = inChild({ FRIZZ_PROBE: "kept" }, `process.env.NODE_ENV = "development"\n${REPORT}`)
  assert.equal(out.live, "development", "negative control: the process env really was mutated")
  assert.equal(out.worker, null, "unset at launch, so unset in the worker")
  assert.equal(out.workerFromExplicitSource, null, "the reset applies to any source, not only process.env")
  assert.equal(out.daemon, null, "a daemon forked from launchEnvironment snapshots the clean value")
  assert.equal(out.daemonKeepsControlPlane, "kept", "launchEnvironment keeps FRIZZ_ vars; a daemon needs them")
})

test("a NODE_ENV the operator exported before launch still passes through", () => {
  const out = inChild({ NODE_ENV: "production" }, `process.env.NODE_ENV = "development"\n${REPORT}`)
  assert.equal(out.live, "development")
  assert.equal(out.worker, "production", "the operator's own export is theirs to keep")
  assert.equal(out.workerFromExplicitSource, "production")
  assert.equal(out.daemon, "production")
})

// The real culprit, not a stand-in: Vite 8's resolveConfig is what wrote NODE_ENV in the dev server.
test("the value the real Vite resolveConfig writes is reset for workers", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-vite-env-"))
  try {
    const out = inChild({}, [
      // Resolved from HERE: the child runs in a scratch root that has no node_modules of its own.
      `const { resolveConfig } = await import(${JSON.stringify(import.meta.resolve("vite"))})`,
      'await resolveConfig({ root: process.cwd(), configFile: false, logLevel: "silent" }, "serve")',
      REPORT,
    ].join("\n"), root)
    assert.equal(out.live, "development", "negative control: Vite wrote NODE_ENV into process.env")
    assert.equal(out.worker, null)
    assert.equal(out.daemon, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("in this process too: a later write is replaced by the launch value, which capture never re-reads", () => {
  const launch = captureLaunchEnvironment().get("NODE_ENV")
  const before = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = "frizz-test-injected"
    assert.equal(captureLaunchEnvironment().get("NODE_ENV"), launch, "capture is idempotent: first snapshot wins")
    assert.equal(inheritWorkerEnvironment().NODE_ENV, launch)
    assert.equal(launchEnvironment().NODE_ENV, launch)
  } finally {
    if (before === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = before
  }
})
