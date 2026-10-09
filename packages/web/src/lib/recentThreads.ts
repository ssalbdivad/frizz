// THE THREADS THIS TAB TOUCHED LATELY, for the folded Snoozed and Done headers (prefs `showRecentThreads`).
// A thread the human just opened or acted on and then sent back to a folded band is the one they reach for
// next, and expanding the band each time to find it is the friction (David 2026-10-09: "i always find myself
// having to expand to interact with threads again"). The row stays IN its band, under that band's header —
// never lifted into Queue or Running, which would put a thread outside the one band it is in.
//
// Keyed by SLUG alone: thread names are unique across every open project, and the one place that sees every
// touch — the RPC client (lib/humanActs.ts), through which every read and act on a thread goes — knows the
// slug but not the project. Per tab and in memory: what this screen touched, not an account fact.

/** How long a touched thread stays under its folded band's header. */
export const RECENT_MS = 30 * 60_000

const touched = new Map<string, number>()

/** Records that the human opened, read or acted on this thread now. */
export function touchThread(slug: string, now = Date.now()): void {
  touched.set(slug, now)
}

/** When the human last touched this thread, if within the window. */
export function touchedAt(slug: string, now = Date.now()): number | undefined {
  const at = touched.get(slug)
  if (at === undefined) return undefined
  if (now - at >= RECENT_MS) {
    touched.delete(slug)
    return undefined
  }
  return at
}

/** The items touched within the window, most recent first. */
export function recentOf<T>(items: readonly T[], keyOf: (item: T) => string, now = Date.now()): T[] {
  return items
    .map((item) => ({ item, at: touchedAt(keyOf(item), now) }))
    .filter((entry): entry is { item: T; at: number } => entry.at !== undefined)
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.item)
}

/** Test seam: forget every touch. */
export function resetRecentThreads(): void {
  touched.clear()
}
