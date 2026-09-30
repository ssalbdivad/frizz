import { showToast } from "../store.ts"

// FEEDBACK FOR A SLOW OPEN OUTSIDE FRIZZ — an editor on a thread's folder, a file in the External app.
// The RPC answers as soon as the opener process STARTS, but the window it brings up can take seconds
// more (VS Code over WSL routinely does), and until 2026-09-30 nothing on the page moved in between: a
// press looked like a miss, so it got pressed again, and every press opened another window.
//
// So each open shows a spinner the moment it is asked for, settles to a short confirmation or the
// error, and is held for OPEN_COOLDOWN_MS past its answer: a repeat of the SAME open (same key) in that
// window re-shows the pending toast instead of spawning a second opener. A different key opens at once.
const OPEN_COOLDOWN_MS = 3_000
const busy = new Map<string, number>() // key → when it may run again (Infinity while in flight)

export async function runExternalOpen<T>(
  key: string,
  pending: string,
  open: () => Promise<T>,
  settled: (result: T) => void | Promise<void>,
  failure: (message: string) => string,
): Promise<void> {
  const until = busy.get(key)
  if (until !== undefined && Date.now() < until) {
    if (until === Infinity) showToast(pending, { spinner: true, sticky: true })
    return
  }
  busy.set(key, Infinity)
  showToast(pending, { spinner: true, sticky: true })
  try {
    await settled(await open())
  } catch (error) {
    showToast(failure((error instanceof Error ? error.message : String(error)).slice(0, 100)))
    busy.delete(key) // a failed open is retried at once — the cooldown guards only against a second window
    return
  }
  busy.set(key, Date.now() + OPEN_COOLDOWN_MS)
}

/** The last segment of a path, for a toast that names what was opened. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || path
}

/** Test seam: the cooldowns are module state. */
export function resetExternalOpens(): void {
  busy.clear()
}
