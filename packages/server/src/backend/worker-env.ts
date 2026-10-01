// THE one rule for what a dispatched worker's process environment contains: everything frizz itself was
// started with, MINUS frizz's own control-plane variables. One module, used by every transport, because
// the thing this replaced was three independent ALLOWLISTS that had already drifted apart.
//
// ── WHY THIS IS A DENYLIST NOW ─────────────────────────────────────────────────────────────────
// Until 2026-08-02 each transport curated its own allowlist of variables to forward: ENV_ALLOWLIST
// (claude broker, 16 keys), EXPLICIT_CLAUDE_ENV_KEYS (the SDK layer, which THREW on anything else) and
// CODEX_APP_SERVER_ENV_KEYS (~35 keys). The stated rationale was that an agent's tool subprocesses
// inherit its environment, so forwarding host secrets broadens agent authority.
//
// That reasoning does not survive contact with what an agent can already do. A worker has a shell and
// full filesystem read: anything in the environment worth stealing is also sitting in ~/.aws/credentials,
// ~/.config/gh/hosts.yml or ~/.npmrc. Withholding GITHUB_TOKEN from a process that can run
// `gh auth token` is not a boundary.
//
// Meanwhile the cost was real and had already produced a defect. The three lists diverged: HTTP_PROXY,
// HTTPS_PROXY, NO_PROXY and SSL_CERT_FILE reached a CODEX worker and not a CLAUDE one, so behind a
// corporate proxy the same task succeeded or failed depending on which backend the operator picked.
// Neither list carried SSH_AUTH_SOCK (no ssh-agent, so no git over SSH), NODE_EXTRA_CA_CERTS (custom
// CAs), or any toolchain variable — NVM_DIR, GOPATH, CARGO_HOME, JAVA_HOME, PYENV_ROOT — so a build run
// inside a worker could behave differently from the identical build in the operator's own shell, for
// reasons nothing in the logs would explain. Every new variable also cost two edits in two files.
//
// t3code, the closest comparable tool (a GUI wrapping the same provider CLIs), passes process.env
// through verbatim and merges user overrides on top — see mergeProviderInstanceEnvironment. So does
// essentially every other developer tool. Matching that is the least-surprise behavior: if you export
// something before launching frizz, your agents see it.
//
// ── WHAT IS STILL DENIED, AND WHY ──────────────────────────────────────────────────────────────
// Frizz's OWN variables, by the `FRIZZ_` prefix. These are control plane, not developer environment:
//   · FRIZZ_CLAUDE_BROKER / FRIZZ_CODEX_APP_SERVER_DAEMON carry a daemon's entire config as JSON,
//     including socket paths and the record path it publishes to.
//   · FRIZZ_LAUNCH_OWNER_TOKEN, FRIZZ_SERVER_LOCK and the FRIZZ_LAUNCH_* set are the launch identity that
//     decides which server owns which project.
//   · FRIZZ_THREAD / FRIZZ_PERM_DIR / FRIZZ_NATIVE_ASK / FRIZZ_PERM_POLICY are what the cc-worker hooks
//     gate on. A worker dispatched to work ON frizz would otherwise inherit the SERVER's values and the
//     hooks would read another thread's identity.
// Denying the whole prefix rather than a hand-kept list is deliberate: it is the same "cannot drift"
// property the allowlists failed to hold, pointing the other way. The handful of FRIZZ_ variables a
// worker genuinely needs are re-added explicitly afterwards, because every caller merges its own
// `workerEnv` ON TOP of this (see the broker's `env:` and the bridge's `attach`).
//
// ── WHAT FRIZZ ITSELF WROTE, AND WHY IT IS RESET RATHER THAN DENIED ────────────────────────────
// "What you exported" is the LAUNCH environment, and process.env is not that once frizz is running:
// the dev server creates Vite in-process, and Vite 8's resolveConfig does
// `if (!isNodeEnvSet) process.env.NODE_ENV = defaultNodeEnv` (vite/dist/node/chunks/node.js), so
// every worker of a `nub run dev` frizz started with NODE_ENV=development nobody exported. That broke
// real work: `next build` in a worker died prerendering /_global-error with "Cannot read properties of
// null (reading 'useContext')", because Next keeps a non-standard NODE_ENV (2026-09-30).
//
// Denying NODE_ENV would fix that and break the rule above — an operator who DID export
// NODE_ENV=production before launching frizz must still see it. So the keys frizz's own in-process
// tooling writes are instead taken from a snapshot of this process's environment at module load, which
// is before anything runs: an operator's value comes through, a value frizz injected does not, and a
// key absent at launch is absent in the worker. The list is exactly what Vite writes into process.env
// (NODE_ENV in resolveConfig; VITE_USER_NODE_ENV, BROWSER and BROWSER_ARGS from a `.env` file in
// loadEnv); add a key here when another in-process dependency starts writing one.
//
// The snapshot is per PROCESS, which is why the daemon spawn sites (claude-broker-host, the codex and
// ACP hosts) hand their daemon `launchEnvironment()` rather than `process.env`: a broker forked with the
// server's live env would snapshot Vite's value as its own launch value, and the Claude SDK builds the
// worker's env inside the broker from the broker's own process.env.
//
// This is NOT a secrets boundary and must not be described as one. It keeps frizz's plumbing out of a
// worker's environment; it does not keep the operator's credentials out, and it never could.
const FRIZZ_INTERNAL_PREFIX = "FRIZZ_"

/** Whether `key` is one of frizz's own control-plane variables — the only thing a worker does not
 *  inherit. Exported so the transports and their tests share one predicate rather than three. */
export function isFrizzInternalEnvKey(key: string): boolean {
  return key.startsWith(FRIZZ_INTERNAL_PREFIX)
}

/** Keys frizz's own in-process dependencies write into process.env at runtime — see the header. */
export const RUNTIME_WRITTEN_ENV_KEYS = ["NODE_ENV", "VITE_USER_NODE_ENV", "BROWSER", "BROWSER_ARGS"] as const

let launchValues: ReadonlyMap<string, string | undefined> | undefined

/** Snapshot this process's launch values of RUNTIME_WRITTEN_ENV_KEYS. Runs at module load; idempotent,
 *  so the code that creates Vite calls it too, to keep the ordering from resting on the import graph. */
export function captureLaunchEnvironment(): ReadonlyMap<string, string | undefined> {
  launchValues ??= new Map(RUNTIME_WRITTEN_ENV_KEYS.map((key) => [key, process.env[key]]))
  return launchValues
}
captureLaunchEnvironment()

/** A copy of `source` with every runtime-written key it carries reset to this process's launch value
 *  (deleted if it was unset at launch). A key `source` does not carry stays absent: a caller that scoped
 *  its env down is not handed one back. Unlike inheritWorkerEnvironment it keeps FRIZZ_ variables, so it
 *  is what a daemon's OWN environment is spawned from. */
export function launchEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  for (const [key, value] of captureLaunchEnvironment()) {
    if (!(key in env)) continue
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/** The environment a dispatched worker starts from: `source` (frizz's own process env by default) with
 *  the runtime-written keys put back to their launch values (see launchEnvironment), frizz's
 *  control-plane variables removed and undefined values dropped. Callers merge their per-thread
 *  `workerEnv` on top — that is what puts the FRIZZ_ variables a worker DOES need back, with this
 *  thread's values rather than the server's. */
export function inheritWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(launchEnvironment(source))) {
    if (value === undefined || isFrizzInternalEnvKey(key)) continue
    env[key] = value
  }
  return env
}
