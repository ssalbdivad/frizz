import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frizzPaths, type FrizzPaths } from "@frizz/server/frizz-paths"
import { acquireProjectLaunchOwner, projectLaunchTokenProof } from "@frizz/server/project-launch"
import { discoverFrizz, launchTokenProof, originFromSetting, ownedFrizz } from "./discovery.ts"

interface Health {
  ok: true
  bootId: string
  projectId?: string
  projectDir?: string
  ownerProof?: string
}

/** A real listener answering /_frizz/health the way the server does (app.ts), and 404 for anything else. */
async function healthServer(health: () => Health): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url !== "/_frizz/health") {
      response.statusCode = 404
      response.end("Not Found")
      return
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(health()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { port: (server.address() as AddressInfo).port, server }
}

/** A port nothing listens on: bound, then released. */
async function deadPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

function fixtureRoots(): { home: string; roots: FrizzPaths } {
  const home = mkdtempSync(join(tmpdir(), "frizz-vscode-discovery-"))
  return { home, roots: frizzPaths({ home, env: {}, platform: "linux" }) }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

test("the launch-token proof is byte-for-byte the server's projectLaunchTokenProof", () => {
  for (const [projectId, projectDir] of [[randomUUID(), "/home/me/repo"], [randomUUID(), "C:\\Users\\me\\repo"], [randomUUID(), "/tmp/ünïcode dir"]] as const) {
    const token = randomUUID()
    const theirs = projectLaunchTokenProof({ projectId, projectDir, stateDir: "/unused" }, token)
    assert.equal(launchTokenProof(projectId, projectDir, token), theirs)
    // Negative control: every input is load-bearing, so a near-miss is a different proof.
    assert.notEqual(launchTokenProof(projectId, `${projectDir}/`, token), theirs)
    assert.notEqual(launchTokenProof(projectId, projectDir, randomUUID()), theirs)
  }
})

test("frizz.serverUrl is read as an origin, and loopback is always spelled 127.0.0.1", () => {
  assert.equal(originFromSetting(""), undefined)
  assert.equal(originFromSetting("   "), undefined)
  assert.equal(originFromSetting("9393"), "http://127.0.0.1:9393")
  assert.equal(originFromSetting("localhost:9393"), "http://127.0.0.1:9393")
  assert.equal(originFromSetting("http://localhost:9393/?project=frizz"), "http://127.0.0.1:9393")
  assert.equal(originFromSetting("http://[::1]:19393"), "http://127.0.0.1:19393")
  assert.equal(originFromSetting("http://127.0.0.1:9494/all/x"), "http://127.0.0.1:9494")
  assert.equal(originFromSetting("https://frizz.example.com"), "https://frizz.example.com")
  assert.equal(originFromSetting("ftp://127.0.0.1:9393"), undefined)
  assert.equal(originFromSetting("http://"), undefined)
})

test("the setting wins outright — nothing on disk is read and no port is probed", async () => {
  const { home, roots } = fixtureRoots()
  try {
    writeJson(join(roots.state, "frizz-server", "address.json"), { version: 1, port: 1 })
    const result = await discoverFrizz({ serverUrl: "localhost:4567", roots, ports: [], pidAlive: () => assert.fail("no pid is checked") })
    assert.deepEqual(result.found, { origin: "http://127.0.0.1:4567", port: 4567, source: "setting" })
    assert.equal((await discoverFrizz({ serverUrl: "ftp://nope", roots })).found, undefined, "a setting that names no http address finds nothing rather than falling back")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the launcher's address record is taken while its port answers health, and passed over once it does not", async () => {
  const { home, roots } = fixtureRoots()
  const { port, server } = await healthServer(() => ({ ok: true, bootId: "boot" }))
  try {
    writeJson(join(roots.state, "frizz-server", "address.json"), { version: 1, ownerToken: randomUUID(), pid: 1, processStart: "x", publisherToken: randomUUID(), port })
    const live = await discoverFrizz({ roots, ports: [] })
    assert.deepEqual(live.found, { origin: `http://127.0.0.1:${port}`, port, source: "owner-record" })

    // Negative control: the same record over a dead listener (a crash leaves it behind) finds nothing.
    writeJson(join(roots.state, "frizz-server", "address.json"), { version: 1, port: await deadPort() })
    const dead = await discoverFrizz({ roots, ports: [] })
    assert.equal(dead.found, undefined)
    assert.match(dead.notes.join("\n"), /does not answer/)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("a well-known port is joined only when its health proves THIS user's launch token", async () => {
  const { home, roots } = fixtureRoots()
  const projectDir = join(home, "repo")
  mkdirSync(projectDir)
  const projectId = randomUUID()
  const stateDir = join(roots.data, "projects", projectId)
  mkdirSync(stateDir, { recursive: true })
  // The real writer of the owner record, so the reader is pinned to the format the server writes.
  const lease = acquireProjectLaunchOwner({ projectId, projectDir, stateDir }, "launcher")
  let health: Health = { ok: true, bootId: "boot", projectId, projectDir, ownerProof: projectLaunchTokenProof({ projectId, projectDir, stateDir }, lease.token) }
  const { port, server } = await healthServer(() => health)
  const closed = await deadPort()
  try {
    assert.equal(await ownedFrizz(port, roots.data), true)
    const found = await discoverFrizz({ roots, ports: [closed, port] })
    assert.deepEqual(found.found, { origin: `http://127.0.0.1:${port}`, port, source: "well-known-port" })

    // Another account's Frizz or a --sandbox one: the same health shape, a token we do not hold.
    health = { ...health, ownerProof: projectLaunchTokenProof({ projectId, projectDir, stateDir }, randomUUID()) }
    assert.equal(await ownedFrizz(port, roots.data), false)
    assert.equal((await discoverFrizz({ roots, ports: [port] })).found, undefined)

    // A listener naming a project id that is not a uuid never gets to aim a path at our data root.
    health = { ok: true, bootId: "boot", projectId: "../../etc", projectDir, ownerProof: "0".repeat(64) }
    assert.equal(await ownedFrizz(port, roots.data), false)
  } finally {
    server.close()
    lease.release()
    rmSync(home, { recursive: true, force: true })
  }
})

test("frizz-dev's public port beats server.lock's private one; server.lock is the last resort, while its pid lives", async () => {
  const { home, roots } = fixtureRoots()
  const projectId = randomUUID()
  const publicSide = await healthServer(() => ({ ok: true, bootId: "boot" }))
  const privateSide = await healthServer(() => ({ ok: true, bootId: "boot" }))
  try {
    writeJson(join(roots.data, "server.lock"), { pid: 4242, port: privateSide.port, projectId })
    const alive = new Set([4242, 5151])

    const lockOnly = await discoverFrizz({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })
    assert.deepEqual(lockOnly.found, { origin: `http://127.0.0.1:${privateSide.port}`, port: privateSide.port, source: "server-lock" })

    writeJson(join(roots.data, "projects", projectId, "dev-supervisor.lock"), { pid: 5151, port: publicSide.port })
    const dev = await discoverFrizz({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })
    assert.deepEqual(dev.found, { origin: `http://127.0.0.1:${publicSide.port}`, port: publicSide.port, source: "dev-supervisor" })

    // A dead supervisor's record is skipped for the control plane's own port.
    alive.delete(5151)
    assert.equal((await discoverFrizz({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })).found?.source, "server-lock")

    // Negative control: a lock whose writer is gone is not an address, even though the port answers.
    alive.delete(4242)
    const stale = await discoverFrizz({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })
    assert.equal(stale.found, undefined)
    assert.match(stale.notes.join("\n"), /pid 4242, which is gone/)
  } finally {
    publicSide.server.close()
    privateSide.server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("with nothing on disk and nothing listening, discovery finds nothing and says where it looked", async () => {
  const { home, roots } = fixtureRoots()
  try {
    const result = await discoverFrizz({ roots, ports: [await deadPort()] })
    assert.equal(result.found, undefined)
    assert.equal(result.notes.length, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
