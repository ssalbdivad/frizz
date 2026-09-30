import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { MACHINE_SETTING_KEYS, Settings } from "@frizz/shared"
import { frizzPaths } from "./frizz-paths.ts"
import { homeFolderProblem } from "./home-folder.ts"
import { deleteMachineConfig, readMachineConfig, writeMachineConfig } from "./machine-config.ts"
import type { Storage } from "./storage.ts"

const SETTINGS_KEY = "settings"

/**
 * The settings that describe the MACHINE rather than a project.
 *
 * `notifications` tracks an OS permission, `localFileOpener` names which editor is installed, and
 * `homeFolder` is where their projectless prompts run (home-workspace.ts); none was ever a property of a repository. The
 * record was created for `font` (2026-08-25), which was inconsistent before one server served every
 * project — stored per project, mirrored per ORIGIN for a pre-paint guard — and that key is gone
 * since 2026-09-19: the interface is sans everywhere and offers no choice.
 *
 * They live as the `settings` record of the machine config store (machine-config.ts). Before that
 * store existed (2026-08-25) they were a file of their own, `<data>/settings.json`; it is read as a
 * fallback and never written again, so an existing install keeps its values until the next save
 * promotes them. Below that, resolution falls back through the project blob (see getSettings) — the
 * same shape, one level down, and the reason neither step needed a migration.
 *
 * `home` is REQUIRED and deliberately not defaulted to homedir(). These were pure storage functions
 * before this file learned about a machine-level record; defaulting it silently turned every existing
 * caller — the test suite included — into one that reads and WRITES the real ~/.frizz. That is not
 * hypothetical: the first run of this change wrote `notifications: false` into the maintainer's own
 * settings, which would have quietly turned their desktop notifications off.
 */
const MACHINE_KEYS = MACHINE_SETTING_KEYS
type MachineSettings = Pick<Settings, (typeof MACHINE_KEYS)[number]>
const MachineSettingsRecord = Settings.partial()

/** The pre-store file. Read-only since 2026-08-25; `resetSettings` is the only thing that removes it. */
export function legacyMachineSettingsPath(home: string): string {
  return join(frizzPaths({ home }).data, "settings.json")
}

function pickMachine(settings: Settings): MachineSettings {
  return Object.fromEntries(MACHINE_KEYS.map((key) => [key, settings[key]])) as MachineSettings
}

/** Whatever of the machine settings is readable: the store's record, else the legacy file. A miss is a fallback, never an error. */
export function readMachineSettings(home: string): Partial<MachineSettings> {
  const stored = readMachineConfig(home, SETTINGS_KEY, MachineSettingsRecord)
  if (stored) return pickPresent(stored)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(legacyMachineSettingsPath(home), "utf8"))
  } catch {
    return {}
  }
  if (!raw || typeof raw !== "object") return {}
  const parsed = MachineSettingsRecord.safeParse(raw)
  return parsed.success ? pickPresent(parsed.data) : {}
}

function pickPresent(partial: Partial<Settings>): Partial<MachineSettings> {
  const out: Partial<MachineSettings> = {}
  for (const key of MACHINE_KEYS) if (partial[key] !== undefined) Object.assign(out, { [key]: partial[key] })
  return out
}

export function writeMachineSettings(next: MachineSettings, home: string): void {
  writeMachineConfig(home, SETTINGS_KEY, next)
}

export const defaultSettings = (): Settings => ({
  // `bypassPermissions` = claude's --dangerously-skip-permissions: a headless worker never stops on an
  // approval card. Shipped default since 0.7.2 (maintainer 2026-08-24); the "Permissions" control
  // behind the Claude Code gear in the model picker can lower it to `auto` — the CLI's classifier mode, where risky actions
  // still surface an approval card in the thread. Those are the only two values a headless worker can
  // run in: the dispatch floor (WORKER_DISPATCH_PERMISSION) stays `auto`, and workerDispatchPermission
  // honors exactly one deviation from it, which is this one.
  permissionMode: "bypassPermissions",
  model: undefined,
  effort: undefined,
  notifications: true,
  localFileOpener: "system",
  // 500K tokens: half the 1M window every Claude worker is dispatched with. See the schema for why a
  // worker left to compact at 1M is the biggest single reason a Frizz thread out-spends the TUI.
  autoCompactWindow: 500_000,
  // "auto" = the CLI's own tier (1h on a subscription). See the schema and claudePromptCacheEnv for
  // when "5m" is the cheaper choice.
  promptCacheTtl: "auto",
  // Unset = codex's own window for the model (272K on GPT-5.6). The schema and codexContextWindowConfig
  // explain the 872K ceiling a larger value is clamped to.
  codexContextWindow: undefined,
  // Inside the project, never beside it — see the schema and cc-worker/hooks/worktree.mjs.
  worktreeDir: ".frizz/worktrees",
  removeWorktreesOnDone: true,
  // Never — see the schema.
  deleteDoneThreadsUntouchedDays: 0,
})

// Settings persist as one JSON blob under settings['settings']. Read merges over defaults
// (so a schema addition lands with a sane value on an old DB); a parse/validation miss also
// degrades to defaults rather than throwing.
export function getSettings(storage: Storage, home: string): Settings {
  const raw = storage.getSetting(SETTINGS_KEY)
  const project =
    raw === undefined
      ? defaultSettings()
      : (Settings.safeParse({ ...defaultSettings(), ...(raw as object) }).data ?? defaultSettings())
  // machine file → this project's stored blob → shipped default. The middle term is what makes this
  // need no migration: a project that has a value keeps it until the next save promotes it upward.
  return { ...project, ...readMachineSettings(home) }
}

export function setSettings(storage: Storage, next: Settings, home: string): Settings {
  const validated = Settings.parse(next)
  if (validated.homeFolder !== undefined) {
    // Stored as the operator typed it, trimmed — and a CLEARED field is stored as "", never dropped. An
    // absent machine key falls back to a project's own blob (getSettings), and every project that was
    // open when a folder was set still carries it there, so dropping the key would resurrect it.
    const folder = validated.homeFolder.trim()
    // Checked only when it CHANGES: a folder that has since been deleted must not make every other
    // setting unsavable. The Home workspace reports that one as missing instead.
    if (folder !== (readMachineSettings(home).homeFolder ?? "").trim()) {
      const problem = homeFolderProblem(folder, home)
      if (problem) throw new Error(problem)
    }
    validated.homeFolder = folder
  }
  writeMachineSettings(pickMachine(validated), home)
  storage.setSetting(SETTINGS_KEY, validated)
  return validated
}

// Clear the stored blob so getSettings falls back to defaults (incl. the shipped default prompt).
// A reset means DEFAULTS, so the machine record goes too — and the legacy file with it, or the
// fallback would resurrect the old values. Other records in the store (the prompt box's profile) are
// not settings and stay.
export function resetSettings(storage: Storage, home: string): Settings {
  storage.deleteSetting(SETTINGS_KEY)
  deleteMachineConfig(home, SETTINGS_KEY)
  try {
    rmSync(legacyMachineSettingsPath(home), { force: true })
  } catch {
    // Nothing to reset, or unreadable — either way defaults are what the caller gets.
  }
  return defaultSettings()
}
