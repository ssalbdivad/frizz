import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// WHEN THE TWO WORKER-MAINTENANCE VERBS APPLY, stated once. The desktop header draws them as icons
// (ReloadPluginsButton, RestartWorkerButton) and the phone's ⋯ sheet draws them as rows; both read these
// predicates, so the phone can never offer a verb the header would hide, or the reverse.

/** Reload plugins: a live broker-backed Claude worker frizz owns. */
export function offersReloadPlugins(thread: ThreadView): boolean {
  if (thread.kind !== "session" || thread.foreign) return false
  if (thread.claudeRuntime !== "broker") return false
  return thread.runtime !== "exited"
}

/** Restart worker: a live Claude worker frizz owns, on a dev build of frizz only. */
export function offersRestartWorker(thread: ThreadView, devBuild: boolean): boolean {
  if (!devBuild) return false
  if (thread.kind !== "session" || thread.foreign) return false
  if (thread.backend === "codex" || thread.backend === "acp") return false
  return thread.runtime !== "exited"
}

/** Re-read the worker's plugin closure into the running session, and say what came back in a toast.
 *  Never throws: a refusal is the toast. */
export async function reloadThreadPlugins(thread: ThreadView): Promise<void> {
  try {
    const r = await rpc.reloadThreadPlugins({ slug: thread.id, sessionId: thread.sessionId ?? "" })
    // Report what CHANGED, not "done": the operator's question is "did my edit land?", and a bare
    // success toast answers it no better than silence.
    const parts = [`${r.plugins} plugin${r.plugins === 1 ? "" : "s"}`, `${r.commands} skill${r.commands === 1 ? "" : "s"}`, `${r.agents} agent${r.agents === 1 ? "" : "s"}`]
    // An MCP change is the one with a real cost — the provider re-reads the whole conversation
    // instead of using its prompt cache — so it is named rather than folded into the counts.
    const mcp = r.mcpServers.length ? ` · MCP: ${r.mcpServers.join(", ")}` : ""
    const errors = r.errorCount ? ` · ${r.errorCount} load error${r.errorCount === 1 ? "" : "s"}` : ""
    showToast(`Reloaded ${parts.join(", ")}${mcp}${errors}`)
  } catch (error) {
    showToast((error instanceof Error ? error.message : "Plugin reload failed").slice(0, 120))
  }
}
