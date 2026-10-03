// The ACP daemon's socket ownership, driven against the REAL daemon process over its REAL socket with
// the fake agent standing in for `opencode acp`. The rest of the daemon's wire (reattach, adopt,
// replay) is exercised through the bridge in acp-bridge.test.ts; these two are about which socket FILE
// a daemon may consider its own — the question that lost a Claude thread's messages on 2026-09-30
// (socket-ownership.ts). The end-to-end reproduction, for codex and ACP both, is
// scripts/verify-daemon-socket-takeover.mjs.
import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { acpDaemonRecordPath, acpDaemonSocketPath, daemonAcpHost, liveAcpDaemonRecord, stopAcpDaemon, type AcpHostOptions } from "./acp-host.ts"

const FAKE = fileURLToPath(new URL("./acp.fixtures/fake-acp-agent.mjs", import.meta.url))
const SESSION = "s1"
const NO_UNIX_SOCKET = process.platform === "win32" && "a named pipe has no file to lose and no inode to compare"

function options(stateDir: string, extra: Partial<AcpHostOptions> = {}): AcpHostOptions {
  return { stateDir, threadSlug: "t1", sessionId: SESSION, command: process.execPath, args: [FAKE], cwd: stateDir, env: process.env, timeoutMs: 15_000, ...extra }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function waitForExit(pid: number, withinMs: number, what: string): Promise<void> {
  const deadline = Date.now() + withinMs
  for (;;) {
    if (!alive(pid)) return
    if (Date.now() > deadline) assert.fail(`${what} (pid ${pid}) was still alive after ${withinMs}ms`)
    await delay(25)
  }
}

/** The generation in the `hello` a fresh connection to `socketPath` is greeted with, or null. */
function helloGeneration(socketPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = connect(socketPath)
    let buf = ""
    const done = (value: string | null): void => { sock.destroy(); resolve(value) }
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8")
      const i = buf.indexOf("\n")
      if (i < 0) return
      try { done((JSON.parse(buf.slice(0, i)) as { generation?: string }).generation ?? null) } catch { done(null) }
    })
    sock.on("error", () => done(null))
  })
}

// Discoverable takes BOTH halves: the record naming the daemon and the socket path it names still
// leading there. Negative control: against the pre-fix daemon it never exits here.
test("acp daemon: a recorded daemon whose socket file is gone collects itself as socket-lost", { skip: NO_UNIX_SOCKET }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-daemon-test-"))
  const attachment = await daemonAcpHost(options(stateDir, { reachabilityCheckMs: 150 }))
  const record = liveAcpDaemonRecord(stateDir, SESSION)!
  try {
    attachment.process.kill() // detach, the way a recycled runtime does
    await delay(200)
    assert.ok(alive(record.daemonPid), "alive while record and socket both lead to it")

    unlinkSync(acpDaemonSocketPath(stateDir, SESSION))

    await waitForExit(record.daemonPid, 5_000, "the daemon nobody can reach")
    await waitForExit(record.childPid, 5_000, "its agent")
    const exit = JSON.parse(readFileSync(`${acpDaemonRecordPath(stateDir, SESSION)}.exit`, "utf8")) as { reason: string }
    assert.equal(exit.reason, "self-collected-socket-lost")
    assert.equal(existsSync(acpDaemonRecordPath(stateDir, SESSION)), false, "it removed its own record, so the next open forks at once")
  } finally {
    await stopAcpDaemon(stateDir, SESSION)
  }
})

// Two daemons for one session bind ONE socket path. A loser dying while the record is ABSENT — which
// forkDaemon makes it on purpose right before it spawns — took "no owner" for "mine" and unlinked the
// successor's socket file. Negative control: against the pre-fix daemon the existsSync below fails.
test("acp daemon: a loser dying while the record is absent leaves its successor's socket alone", { skip: NO_UNIX_SOCKET }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-daemon-test-"))
  const recordFile = acpDaemonRecordPath(stateDir, SESSION)
  const socketPath = acpDaemonSocketPath(stateDir, SESSION)
  // Default reachability interval (30s): neither daemon may collect itself while the test runs.
  const first = await daemonAcpHost(options(stateDir))
  const loser = liveAcpDaemonRecord(stateDir, SESSION)!
  first.process.kill()
  unlinkSync(recordFile)
  const second = await daemonAcpHost(options(stateDir))
  const survivor = liveAcpDaemonRecord(stateDir, SESSION)!
  try {
    assert.equal(second.reattached, false)
    assert.notEqual(survivor.daemonPid, loser.daemonPid, "two daemons for one session, one socket path")

    unlinkSync(recordFile) // the window: a host about to fork has removed the record
    process.kill(loser.daemonPid, "SIGTERM")
    await waitForExit(loser.daemonPid, 5_000, "the loser")

    assert.ok(existsSync(socketPath), "the survivor's socket file outlived the loser's teardown")
    second.process.kill()
    assert.equal(await helloGeneration(socketPath), survivor.generation, "and a new connection reaches the survivor")
  } finally {
    for (const pid of [loser.daemonPid, survivor.daemonPid]) { try { process.kill(pid, "SIGTERM") } catch {} }
    await waitForExit(survivor.daemonPid, 5_000, "the survivor, at teardown")
  }
})
