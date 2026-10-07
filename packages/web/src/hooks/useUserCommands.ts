// The operator's USER SLASH COMMANDS (UserCommand in @frizz/shared), for the composer's `/` menu, the send
// that expands them, and the Settings editor that writes them. One query, keyed by the page's project
// because a project's own `.agents/commands` is part of the list.

import { useQuery, type QueryClient } from "@tanstack/react-query"
import type { ThreadSkill, ThreadSkillSource, UserCommand, UserCommandSource } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { useProjectDir } from "../lib/drafts.ts"

export const userCommandsKey = (projectDir: string | undefined) => ["userCommands", projectDir ?? ""] as const

export function useUserCommands() {
  const projectDir = useProjectDir()
  return useQuery({
    queryKey: userCommandsKey(projectDir),
    queryFn: () => rpc.userCommands(),
    // A command written by hand in another editor shows up on the next page focus; the editor in
    // Settings invalidates on every save, so its own writes show at once.
    staleTime: 30_000,
  })
}

/** The list as the composer's menu asks for it, fetched (or served from cache) on demand. */
export function fetchUserCommands(qc: QueryClient, projectDir: string | undefined): Promise<UserCommand[]> {
  return qc
    .fetchQuery({ queryKey: userCommandsKey(projectDir), queryFn: () => rpc.userCommands(), staleTime: 30_000 })
    .then((r) => r.commands, () => [])
}

export function invalidateUserCommands(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ["userCommands"] })
}

const MENU_SOURCE: Record<UserCommandSource, ThreadSkillSource> = { frizz: "frizz", project: "project", global: "user" }

/** User commands as menu rows. Not built-in COMMANDS in the menu's sense: Frizz expands a user command at
 *  any word boundary (expandUserCommandDraft), so like a skill it is offered and tinted anywhere. */
export function userCommandItems(commands: readonly UserCommand[]): ThreadSkill[] {
  return commands.map((c) => ({ name: c.name, description: c.description, source: MENU_SOURCE[c.source] }))
}

/** The harness's rows and the user commands as ONE menu. A user command shadows a harness row of the
 *  same name, because the send expands it before the harness ever sees the `/` — the row has to say what
 *  will actually run. */
export function mergeSlashItems(harness: readonly ThreadSkill[], commands: readonly UserCommand[]): ThreadSkill[] {
  const mine = new Set(commands.map((c) => c.name))
  return [...harness.filter((s) => !mine.has(s.name)), ...userCommandItems(commands)].sort((a, b) => a.name.localeCompare(b.name))
}
