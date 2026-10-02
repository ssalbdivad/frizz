import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"
import { findOnPath, findOnPathAsync, listAcpAgents, listAcpAgentsCached } from "./acp-agents.ts"

// The `acpAgents` RPC walks PATH off the event loop and memoizes it (acp-agents.ts listAcpAgentsCached):
// on WSL the synchronous walk blocked the server ~2s per call. These pin that the async walk answers what
// the synchronous one does, and that the memo serves instantly without ever going permanently stale.

function sandbox(): { path: string; install: (dir: string, name: string) => string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "acp-agents-"))
  const dirs = ["a", "b", "c"].map((d) => join(root, d))
  for (const d of dirs) mkdirSync(d)
  return {
    path: dirs.join(delimiter),
    install: (dir, name) => {
      const file = join(root, dir, name)
      writeFileSync(file, "#!/bin/sh\n")
      chmodSync(file, 0o755)
      return file
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  }
}

test("the async PATH walk finds what the synchronous one does, first PATH entry winning", { skip: process.platform === "win32" }, async () => {
  const box = sandbox()
  try {
    const env = { PATH: box.path }
    box.install("c", "gemini")
    const first = box.install("b", "gemini")
    // Present but not executable: skipped, as the synchronous walk skips it.
    writeFileSync(join(box.path.split(delimiter)[0]!, "gemini"), "")
    assert.equal(await findOnPathAsync("gemini", env), first)
    assert.equal(await findOnPathAsync("gemini", env), findOnPath("gemini", env))
    assert.equal(await findOnPathAsync("opencode", env), undefined)
    assert.deepEqual(await listAcpAgentsCached(undefined, env, 0), listAcpAgents(undefined, env))
  } finally {
    box.done()
  }
})

test("the agent list is memoized, and a stale answer re-walks behind itself", { skip: process.platform === "win32" }, async () => {
  const box = sandbox()
  try {
    const env = { PATH: box.path }
    const t0 = 1_000_000
    const before = await listAcpAgentsCached(undefined, env, t0)
    assert.equal(before.find((a) => a.id === "opencode")?.bin, undefined)
    const opencode = box.install("a", "opencode")
    // Fresh: served from the memo, so the install is not seen yet.
    assert.equal(listAcpAgentsCached(undefined, env, t0 + 1_000), listAcpAgentsCached(undefined, env, t0 + 2_000))
    assert.equal((await listAcpAgentsCached(undefined, env, t0 + 1_000)).find((a) => a.id === "opencode")?.bin, undefined)
    // Stale: the old answer still comes back at once, and the re-walk it starts lands for the next call.
    const stale = await listAcpAgentsCached(undefined, env, t0 + 61_000)
    assert.equal(stale.find((a) => a.id === "opencode")?.bin, undefined)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = await listAcpAgentsCached(undefined, env, Date.now())
    assert.equal(after.find((a) => a.id === "opencode")?.bin, opencode)
    // A settings edit is a different list, never a stale copy of the old one.
    const custom = await listAcpAgentsCached([{ id: "mine", label: "Mine", command: "opencode" }], env, t0 + 1_000)
    assert.equal(custom.find((a) => a.id === "mine")?.bin, opencode)
  } finally {
    box.done()
  }
})
