import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { createStorage } from "./storage.ts"
import { machineConfigPath, readMachineConfig, writeMachineConfig } from "./machine-config.ts"
import {
  defaultSettings,
  getSettings,
  legacyMachineSettingsPath,
  readMachineSettings,
  resetSettings,
  setSettings,
} from "./settings.ts"
import { z } from "zod"
import { Settings } from "@frizz/shared"

/** The pre-store file, as an install that predates the machine config store would have left it. */
function writeLegacySettings(home: string, value: unknown): void {
  const path = legacyMachineSettingsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

// The sandbox is an XDG-layout home, so an XDG variable inherited from the developer's shell would move
// the machine store — and the registry the Home folder check reads — out of it into their real data root.
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name]

function sandbox(): { home: string; open: (name: string) => ReturnType<typeof createStorage>; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), "frizz-settings-"))
  const opened: ReturnType<typeof createStorage>[] = []
  return {
    home,
    open: (name) => {
      const storage = createStorage(join(home, `${name}.db`), "p")
      opened.push(storage)
      return storage
    },
    done: () => {
      for (const storage of opened) storage.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test("notifications and the file opener are the MACHINE's, shared by every project", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    const beta = box.open("beta")
    assert.equal(getSettings(alpha, box.home).notifications, true)

    setSettings(alpha, { ...defaultSettings(), notifications: false, localFileOpener: "cursor" }, box.home)

    // The point: a project that was never touched sees it, because the value is not its to hold.
    const seen = getSettings(beta, box.home)
    assert.equal(seen.notifications, false)
    assert.equal(seen.localFileOpener, "cursor")
    assert.ok(existsSync(machineConfigPath(box.home)))
  } finally {
    box.done()
  }
})

// `projectRail` was a machine setting until 2026-09-30, so every install that ever saved settings has it
// in the machine store AND in each project's blob. Both must still load — stripped, not rejected — and a
// save must stop writing it.
test("a stale `projectRail` in the machine store and a project blob loads, and is stripped", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    writeMachineConfig(box.home, "settings", { notifications: false, localFileOpener: "cursor", projectRail: true })
    alpha.setSetting("settings", { ...defaultSettings(), permissionMode: "auto", projectRail: true })
    assert.deepEqual(readMachineSettings(box.home), { notifications: false, localFileOpener: "cursor" })
    const loaded = getSettings(alpha, box.home)
    assert.equal(loaded.permissionMode, "auto", "the project blob parsed rather than degrading to defaults")
    assert.equal(loaded.notifications, false)
    assert.equal("projectRail" in loaded, false)

    // A client built before the removal still posts the key; it is dropped, not refused.
    setSettings(alpha, { ...loaded, projectRail: true } as Settings, box.home)
    assert.equal("projectRail" in (readMachineConfig(box.home, "settings", z.record(z.string(), z.unknown())) ?? {}), false)
    assert.equal("projectRail" in (alpha.getSetting("settings") as object), false)
  } finally {
    box.done()
  }
})

test("a project's own settings stay its own", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    const beta = box.open("beta")
    setSettings(alpha, { ...defaultSettings(), permissionMode: "auto", model: "opus" }, box.home)
    assert.equal(getSettings(alpha, box.home).permissionMode, "auto")
    assert.equal(getSettings(beta, box.home).permissionMode, "bypassPermissions", "permissions are per project")
    assert.equal(getSettings(beta, box.home).model, undefined)
  } finally {
    box.done()
  }
})

// No migration ships with this: resolution falls back through the project blob, so an existing
// project keeps what it had until the next save promotes it.
test("a project that already stored a machine value keeps it with no machine file present", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    alpha.setSetting("settings", { ...defaultSettings(), localFileOpener: "cursor" })
    assert.deepEqual(readMachineSettings(box.home), {})
    assert.equal(getSettings(alpha, box.home).localFileOpener, "cursor")

    // …and the next save is what makes it the machine's.
    setSettings(alpha, getSettings(alpha, box.home), box.home)
    assert.equal(readMachineSettings(box.home).localFileOpener, "cursor")
    assert.equal(getSettings(box.open("beta"), box.home).localFileOpener, "cursor")
  } finally {
    box.done()
  }
})

test("reset means defaults, so the machine record goes with the project blob", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    writeLegacySettings(box.home, { localFileOpener: "cursor" })
    setSettings(alpha, { ...defaultSettings(), localFileOpener: "cursor" }, box.home)
    assert.equal(resetSettings(alpha, box.home).localFileOpener, "system")
    assert.equal(readMachineConfig(box.home, "settings", z.unknown()), undefined, "leaving it would resurrect the old value")
    assert.equal(existsSync(legacyMachineSettingsPath(box.home)), false, "…and so would the pre-store file")
    assert.equal(getSettings(alpha, box.home).localFileOpener, "system")
  } finally {
    box.done()
  }
})

test("an unreadable machine store degrades to the project's values rather than throwing", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    setSettings(alpha, { ...defaultSettings(), localFileOpener: "cursor" }, box.home)
    writeFileSync(machineConfigPath(box.home), "{ not json")
    assert.deepEqual(readMachineSettings(box.home), {})
    assert.equal(getSettings(alpha, box.home).localFileOpener, "cursor", "the project blob is still there")
  } finally {
    box.done()
  }
})

// The machine settings were their own file until the machine config store arrived (2026-08-25). An
// install that has that file keeps its values from it; the next save writes the store and never the
// file. A `font` in that file — the key the file was created for — is stripped on read now that the
// setting is gone (2026-09-19), as is `projectRail` (2026-09-30); the other machine keys survive.
test("a pre-store settings.json is read until the next save promotes it into the store", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    writeLegacySettings(box.home, { font: "mono", localFileOpener: "cursor", projectRail: true })
    assert.deepEqual(readMachineSettings(box.home), { localFileOpener: "cursor" })
    assert.equal(getSettings(alpha, box.home).localFileOpener, "cursor")

    setSettings(alpha, { ...getSettings(alpha, box.home), notifications: false }, box.home)
    assert.deepEqual(readMachineConfig(box.home, "settings", Settings.partial()), { notifications: false, localFileOpener: "cursor", worktreeDir: ".frizz/worktrees", removeWorktreesOnDone: true, deleteDoneThreadsUntouchedDays: 0 })
    assert.equal(JSON.parse(readFileSync(legacyMachineSettingsPath(box.home), "utf8")).notifications, undefined, "the legacy file is never written again")
    // The store now wins outright, even where the legacy file disagrees.
    writeLegacySettings(box.home, { localFileOpener: "vscode" })
    assert.equal(getSettings(box.open("beta"), box.home).localFileOpener, "cursor")
  } finally {
    box.done()
  }
})

// The GitHub picker's issue and PR prompts merged into ONE `githubPrompt` on 2026-08-15. The backfill
// is the schema itself: Settings is a non-strict z.object, so a blob still carrying the two old keys
// has them STRIPPED on read, and the reader falls through to the new shipped default. That is the
// maintainer's intended migration — drop every stored override rather than guess how to fuse two
// customized templates into one. This test is what keeps it true if Settings ever turns strict/
// passthrough, which would either throw on an old blob or leak a dead key back out.
test("an old blob's githubIssuePrompt/githubPrPrompt are dropped, not carried into githubPrompt", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    alpha.setSetting("settings", {
      ...defaultSettings(),
      githubIssuePrompt: "my hand-tuned issue template",
      githubPrPrompt: "my hand-tuned PR template",
    })

    const seen = getSettings(alpha, box.home) as Record<string, unknown>
    assert.equal(seen.githubPrompt, undefined, "unset ⇒ the server uses the shipped default")
    assert.equal(seen.githubIssuePrompt, undefined, "the old key does not survive the read")
    assert.equal(seen.githubPrPrompt, undefined)
    // …and the next save writes the stripped shape back, so the dead keys leave the DB for good.
    setSettings(alpha, getSettings(alpha, box.home), box.home)
    const stored = alpha.getSetting("settings") as Record<string, unknown>
    assert.equal("githubIssuePrompt" in stored, false)
    assert.equal("githubPrPrompt" in stored, false)
  } finally {
    box.done()
  }
})

test("retired font preferences are stripped from every settings source without resetting other values", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    alpha.setSetting("settings", { ...defaultSettings(), font: "mono", promptCacheTtl: "5m" })
    for (const source of ["project", "legacy", "machine"]) {
      if (source === "legacy") writeLegacySettings(box.home, { font: "mono", notifications: false })
      if (source === "machine") writeMachineConfig(box.home, "settings", { font: "mono", notifications: false })
      const settings = getSettings(alpha, box.home)
      assert.equal("font" in settings, false, source)
      assert.equal(settings.promptCacheTtl, "5m")
      if (source !== "project") assert.equal(settings.notifications, false)
    }
    setSettings(alpha, Settings.parse({ ...getSettings(alpha, box.home), font: "mono" }), box.home)
    assert.equal("font" in (alpha.getSetting("settings") as object), false)
    assert.equal("font" in readMachineConfig(box.home, "settings", z.record(z.string(), z.unknown()))!, false)
  } finally {
    box.done()
  }
})

// ---- homeFolder: where the Home workspace's agents run (home-workspace.ts) ----

test("a Home folder that does not exist is refused on save", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    assert.throws(() => setSettings(alpha, { ...defaultSettings(), homeFolder: "~/nope" }, box.home), /No folder at/)
    assert.equal(readMachineSettings(box.home).homeFolder, undefined, "nothing was written")
  } finally {
    box.done()
  }
})

test("the Home folder is stored trimmed, as typed, and every project sees it", () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.home, "code"))
    const alpha = box.open("alpha")
    const saved = setSettings(alpha, { ...defaultSettings(), homeFolder: "  ~/code  " }, box.home)
    assert.equal(saved.homeFolder, "~/code", "kept as typed — not expanded — so a moved home still resolves")
    assert.equal(readMachineSettings(box.home).homeFolder, "~/code")
    assert.equal(getSettings(box.open("beta"), box.home).homeFolder, "~/code", "one Home per machine")
  } finally {
    box.done()
  }
})

// Every save sends the WHOLE settings object, so a folder deleted after it was saved rides along on
// every unrelated change. Validating it each time would make the drawer unsavable.
test("a saved Home folder that has since vanished does not block saving anything else", () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.home, "code"))
    const alpha = box.open("alpha")
    setSettings(alpha, { ...defaultSettings(), homeFolder: "~/code" }, box.home)
    rmSync(join(box.home, "code"), { recursive: true })

    const saved = setSettings(alpha, { ...getSettings(alpha, box.home), notifications: false }, box.home)
    assert.equal(saved.notifications, false)
    assert.equal(readMachineSettings(box.home).homeFolder, "~/code")
    // Unchanged modulo the trim is still unchanged.
    assert.doesNotThrow(() => setSettings(alpha, { ...getSettings(alpha, box.home), homeFolder: " ~/code " }, box.home))
    // …but CHANGING it to another missing folder is still checked.
    assert.throws(() => setSettings(alpha, { ...getSettings(alpha, box.home), homeFolder: "~/also-gone" }, box.home), /No folder at/)
  } finally {
    box.done()
  }
})

// getSettings falls back to a project's own blob for an ABSENT machine key, and every project open while
// a folder was set carries it there. A cleared field that dropped the key would bring that folder back.
test("clearing the Home folder stores an empty value that no project's old blob can resurrect", () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.home, "code"))
    mkdirSync(join(box.home, "old"))
    const alpha = box.open("alpha")
    const beta = box.open("beta")
    beta.setSetting("settings", { ...defaultSettings(), homeFolder: "~/old" })
    setSettings(alpha, { ...defaultSettings(), homeFolder: "~/code" }, box.home)

    setSettings(alpha, { ...getSettings(alpha, box.home), homeFolder: "" }, box.home)
    assert.equal(readMachineSettings(box.home).homeFolder, "")
    assert.equal(getSettings(alpha, box.home).homeFolder, "")
    assert.equal(getSettings(beta, box.home).homeFolder, "", "beta's stale blob must not win back")
  } finally {
    box.done()
  }
})
