import { useQuery } from "@tanstack/react-query"
import { backgroundSummariesOn } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"

/**
 * Whether Background summaries is on (Settings) — read from the same `settingsGet` entry the Settings
 * drawer saves into, so turning it off there changes every surface reading this at once
 * (useSettingsAutosave publishes a machine setting to every project's cached copy). On until the read
 * answers, and on an older server that has no such setting: the shipped default.
 */
export function useBackgroundSummaries(): boolean {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  return backgroundSummariesOn(settings.data)
}
