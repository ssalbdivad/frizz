import type { ResolvedDispatchPreferences } from "../lib/dispatchPreferences.ts"
import { profileGridDisplayLabel, type ProfileGridGroup } from "../lib/profileGrid.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"

function label(groups: readonly ProfileGridGroup[], profile: ResolvedDispatchPreferences): string {
  return profileGridDisplayLabel(groups, { provider: profile.backend, model: profile.pickerModel, effort: profile.effort })
}

// Beside a dispatch surface's profile pill while its pick differs from the default. A pick is for the
// thread (or batch) the surface starts next and goes back to the default after it; this is the one
// control that writes the default instead (useDispatchProfile). Its presence is also the only sign
// the pick is a one-off, so it reads as a quiet sibling of the pill, not as a warning.
export function MakeDefaultButton({
  groups,
  pick,
  defaultProfile,
  onClick,
}: {
  groups: readonly ProfileGridGroup[]
  pick: ResolvedDispatchPreferences
  defaultProfile: ResolvedDispatchPreferences
  onClick: () => void
}) {
  const next = label(groups, pick)
  return (
    <button
      type="button"
      data-make-default=""
      onClick={onClick}
      aria-label={`Make ${next} the default for new threads`}
      title={`Start every new thread on ${next} instead of ${label(groups, defaultProfile)}`}
      className={`inline-flex shrink-0 items-center rounded-md border border-transparent px-1.5 py-1 text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${PROMPT_CONTROL_TYPOGRAPHY_CLASS}`}
    >
      Make default
    </button>
  )
}
