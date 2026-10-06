import { backgroundSummariesOn, type Settings } from "@frizz/shared"
import type { ClaudeOneShot } from "./backend/claude-oneshot.ts"

// BACKGROUND SUMMARIES — the one switch over every model call Frizz makes on its own (Settings
// `backgroundSummaries`, default on; the schema in shared lists the calls and their fallbacks).
//
// Every caller already had a mechanical fallback, keyed on its completer being ABSENT: the namer, the
// rest and live status writers, the effort chooser and the schedule interpreter each read `complete`
// (or the namer's `available`) at the moment of a call, never at construction. So the switch is not a
// branch in five modules; it is what `complete` IS — a completer while the setting is on, `undefined`
// while it is off — and each module's existing fallback does the rest. That is also what makes it take
// effect without a restart: nothing captured the completer, so the next call sees the new value.
//
// Until 2026-10-06 the only off-switches were environment variables read once at boot
// (FRIZZ_THREAD_NAMER=0, FRIZZ_LIVE_STATUS=0, FRIZZ_AUTO_EFFORT=0). They still work, as overrides that
// can only turn a call OFF: they cost one boolean each, and an operator who set one in a launcher
// keeps what they asked for. The setting is the switch a human is shown (plans/upstream-superset.md §1).

/** How long one read of the setting is trusted. The live status writer asks on every transcript write
 *  of every running thread, so the read is memoized; two seconds is well inside "without a restart". */
export const BACKGROUND_SUMMARIES_READ_MS = 2_000

export interface BackgroundSummaries {
  /** Whether the setting is on, as of at most BACKGROUND_SUMMARIES_READ_MS ago. */
  on(): boolean
  /**
   * The completer `complete` while the setting is on (and `envOff` is not set), else undefined — read it
   * at the moment of a call, as a getter on a module's deps. Each call that does run is logged at debug,
   * naming `purpose`, so a run's log says exactly which model calls Frizz made.
   */
  model(purpose: string, complete: ClaudeOneShot, envOff?: boolean): () => ClaudeOneShot | undefined
}

export function createBackgroundSummaries(deps: {
  settings: () => Pick<Settings, "backgroundSummaries">
  now?: () => number
  log?: (message: string) => void
}): BackgroundSummaries {
  const now = deps.now ?? Date.now
  let cached: { on: boolean; at: number } | undefined
  const on = (): boolean => {
    const at = now()
    if (!cached || at - cached.at >= BACKGROUND_SUMMARIES_READ_MS) {
      let value = true
      try {
        value = backgroundSummariesOn(deps.settings())
      } catch {
        // An unreadable settings store is not the human turning this off: keep the last reading, else
        // the shipped default.
        value = cached?.on ?? true
      }
      cached = { on: value, at }
    }
    return cached.on
  }
  return {
    on,
    model(purpose, complete, envOff = false) {
      if (envOff) return () => undefined
      const logged: ClaudeOneShot = (request) => {
        deps.log?.(`${purpose}: asking Claude (${request.model ?? "default model"})`)
        return complete(request)
      }
      return () => (on() ? logged : undefined)
    },
  }
}
