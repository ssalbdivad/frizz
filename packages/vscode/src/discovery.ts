// FINDING FRIZZ from an editor window, with nothing configured. Frizz is one server per machine, and
// it leaves records of where it listens in its own data and state roots; this reads them in the order
// that gets the PUBLIC origin — the one the human's tab is on — whenever one exists:
//
//   1. `frizz.serverUrl`, when the human set it. Nothing else is consulted.
//   2. `<state>/frizz-server/address.json` — the published launcher's owner record, naming the port it
//      serves. Valid only while that port answers /_frizz/health: the record outlives a crash.
//   3. The well-known ports (9393, 19393, 9494, 19494), accepted only with the launch-token proof the
//      desktop app checks (packages/desktop/src/server.ts `ownedFrizz`): loopback is shared with every
//      other account on the machine and with a `frizz --sandbox`, so answering proves nothing.
//   4. `<data>/projects/<id>/dev-supervisor.lock` — `frizz-dev`'s public port when it is not on a
//      well-known one. Ours by construction (it is in our own data root), so liveness is enough.
//   5. `<data>/server.lock` — written by every launch mode, but its port is the control plane's
//      PRIVATE listener behind the restart supervisor. RPC and the editor socket work there; a page
//      opened on it is a different origin (its own storage, and a port that moves on every restart).
//      Last for that reason, and only while the pid that wrote it is alive.
//
// Every address is `http://127.0.0.1:<port>`, never `localhost`: the server's origin gate compares
// hostnames exactly, and `localhost` is a different origin to the browser as well.
//
// Pure node — no `vscode` import — so the unit tests run it against fixture roots and a real listener.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { frizzPaths, type FrizzPaths } from "@frizz/server/frizz-paths"

/** `DEFAULT_PORT`, its fallback, `DEFAULT_DEV_PORT`, its fallback (packages/shared `fallbackPort` = +10 000). */
export const WELL_KNOWN_PORTS: readonly number[] = [9393, 19393, 9494, 19494]

export type DiscoverySource = "setting" | "owner-record" | "well-known-port" | "dev-supervisor" | "server-lock"

export interface FoundFrizz {
  origin: string
  port: number
  source: DiscoverySource
}

export interface DiscoveryResult {
  found?: FoundFrizz
  /** One line per place looked, for the log: what was there and why it was or was not taken. */
  notes: string[]
}

export interface DiscoveryOptions {
  /** The `frizz.serverUrl` setting; empty means find it. */
  serverUrl?: string
  roots?: Pick<FrizzPaths, "data" | "state">
  ports?: readonly number[]
  timeoutMs?: number
  pidAlive?: (pid: number) => boolean
}

export interface FrizzHealth {
  ok: true
  bootId: string
  projectId?: string
  projectDir?: string
  ownerProof?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * The origin a `frizz.serverUrl` value names, or undefined when it names none. A bare port and a
 * `host:port` are accepted, and a loopback name is spelled `127.0.0.1` whatever the human typed.
 */
export function originFromSetting(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const spelled = /^\d+$/u.test(value) ? `http://127.0.0.1:${value}` : /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`
  let url: URL
  try {
    url = new URL(spelled)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (LOOPBACK_NAMES.has(url.hostname)) url.hostname = "127.0.0.1"
  return url.origin
}

export async function readHealth(origin: string, timeoutMs = 1_000): Promise<FrizzHealth | undefined> {
  try {
    const response = await fetch(`${origin}/_frizz/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const health = (await response.json()) as Partial<FrizzHealth>
    return health.ok === true && typeof health.bootId === "string" ? (health as FrizzHealth) : undefined
  } catch {
    return undefined
  }
}

/**
 * The launch-token proof a Frizz's health carries: sha256 over a fixed tag, the launching project's id
 * and folder, and the owner token from `<data>/projects/<id>/project-launch.owner`. Reimplemented, not
 * imported — `@frizz/server/project-launch` drags process bookkeeping into the bundle — and pinned
 * byte-for-byte to `projectLaunchTokenProof` by discovery.test.ts.
 */
export function launchTokenProof(projectId: string, projectDir: string, token: string): string {
  return createHash("sha256")
    .update("frizz-project-launch-v2\0")
    .update(projectId)
    .update("\0")
    .update(projectDir)
    .update("\0")
    .update(token)
    .digest("hex")
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
}

export function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, and owned by someone else — still a live writer of the record.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Whether the Frizz on this port is the one THIS user launched from these roots. The health answer
 * names the launching project; its owner record sits in our data root, readable by nobody else, and
 * the proof in the answer must be the hash of the token in it.
 */
export async function ownedFrizz(port: number, data: string, timeoutMs = 1_000): Promise<boolean> {
  const health = await readHealth(loopbackOrigin(port), timeoutMs)
  if (!health || typeof health.projectId !== "string" || typeof health.projectDir !== "string" || typeof health.ownerProof !== "string") return false
  // The id becomes a path segment below; a hostile listener must not be able to aim it elsewhere.
  if (!UUID_RE.test(health.projectId)) return false
  const owner = readJson(join(data, "projects", health.projectId, "project-launch.owner"))
  if (!owner || typeof owner.token !== "string" || !UUID_RE.test(owner.token)) return false
  if (owner.projectId !== health.projectId || owner.projectDir !== health.projectDir) return false
  return launchTokenProof(health.projectId, health.projectDir, owner.token) === health.ownerProof
}

/** Find the running Frizz. Asked again before every connection attempt: the port can move. */
export async function discoverFrizz(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const notes: string[] = []
  const timeoutMs = options.timeoutMs ?? 1_000
  const pidAlive = options.pidAlive ?? defaultPidAlive

  if (options.serverUrl?.trim()) {
    const origin = originFromSetting(options.serverUrl)
    if (!origin) {
      notes.push(`frizz.serverUrl "${options.serverUrl}" is not an http address`)
      return { notes }
    }
    notes.push(`frizz.serverUrl: ${origin}`)
    return { found: { origin, port: Number(new URL(origin).port || (origin.startsWith("https:") ? 443 : 80)), source: "setting" }, notes }
  }

  const roots = options.roots ?? frizzPaths()

  const addressPath = join(roots.state, "frizz-server", "address.json")
  const address = readJson(addressPath)
  if (address && address.version === 1 && validPort(address.port)) {
    if (await readHealth(loopbackOrigin(address.port), timeoutMs)) {
      notes.push(`${addressPath}: port ${address.port} answers`)
      return { found: { origin: loopbackOrigin(address.port), port: address.port, source: "owner-record" }, notes }
    }
    notes.push(`${addressPath}: port ${address.port} does not answer (Frizz may be starting)`)
  } else {
    notes.push(`${addressPath}: none`)
  }

  const ports = options.ports ?? WELL_KNOWN_PORTS
  // In parallel — a closed port refuses at once, and an open one owes us its answer within the timeout —
  // then taken in the listed order, so the result never depends on which reply came back first.
  const owned = await Promise.all(ports.map((port) => ownedFrizz(port, roots.data, timeoutMs)))
  const ownedPort = ports.find((_, i) => owned[i])
  if (ownedPort !== undefined) {
    notes.push(`port ${ownedPort} answers with this user's launch token`)
    return { found: { origin: loopbackOrigin(ownedPort), port: ownedPort, source: "well-known-port" }, notes }
  }
  notes.push(`ports ${ports.join(", ")}: no Frizz of this user's`)

  const lockPath = join(roots.data, "server.lock")
  const lock = readJson(lockPath)
  if (!lock || !validPort(lock.port) || typeof lock.pid !== "number") {
    notes.push(`${lockPath}: none`)
    return { notes }
  }
  if (!pidAlive(lock.pid)) {
    notes.push(`${lockPath}: written by pid ${lock.pid}, which is gone`)
    return { notes }
  }

  if (typeof lock.projectId === "string" && UUID_RE.test(lock.projectId)) {
    const devPath = join(roots.data, "projects", lock.projectId, "dev-supervisor.lock")
    const dev = readJson(devPath)
    if (dev && validPort(dev.port) && typeof dev.pid === "number" && pidAlive(dev.pid) && await readHealth(loopbackOrigin(dev.port), timeoutMs)) {
      notes.push(`${devPath}: port ${dev.port} answers`)
      return { found: { origin: loopbackOrigin(dev.port), port: dev.port, source: "dev-supervisor" }, notes }
    }
  }

  if (await readHealth(loopbackOrigin(lock.port), timeoutMs)) {
    notes.push(`${lockPath}: port ${lock.port} answers (the control plane's own port)`)
    return { found: { origin: loopbackOrigin(lock.port), port: lock.port, source: "server-lock" }, notes }
  }
  notes.push(`${lockPath}: port ${lock.port} does not answer`)
  return { notes }
}
