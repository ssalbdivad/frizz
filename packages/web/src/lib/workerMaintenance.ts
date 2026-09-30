import type { ThreadView } from "@frizz/shared"
import type { Api } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// The two live-process MAINTENANCE verbs — Reload plugins and Restart worker — as the thread menu offers
// them. They were icons in the drawer header's action strip (2026-08-26 to 2026-09-29), and before that in
// the lifecycle footer; the maintainer moved them into the drawer's ⋯ menu on 2026-09-29, with the copy
// terminal command, because each is reached for rarely and they held permanent space beside the two
// doors that are used on nearly every thread (fullscreen and open terminal).
//
// Each is OFFERED only where it can actually work — a menu item that throws is worse than an absent one.

/** Reload plugins re-reads the worker's plugin closure (hooks, skills, agent profiles, MCP servers) INTO
 *  the running session: the board's half of Claude's own `/reload-plugins`. It needs a session thread that
 *  is not a read-only foreign row, a BROKER-backed Claude (a pre-broker row has no control channel to ask,
 *  and the codex app-server client speaks no reload method), and a live process — on an exited thread the
 *  next follow-up already cold-starts on current tooling. */
export function offersReloadPlugins(thread: ThreadView): boolean {
  return thread.kind === "session" && !thread.foreign && thread.claudeRuntime === "broker" && thread.runtime !== "exited"
}

/** Restart worker replaces the live `claude` process, keeping the conversation (lib/restartWorker.ts).
 *  DEV BUILDS ONLY, and the gate is the launcher's runtime answer (lib/devBuild.ts), never
 *  `import.meta.env.DEV`, which is false in the production bundle frizz-dev actually serves. Claude only:
 *  a codex turn lives in the app-server and an ACP session in its agent's own child. Live process only,
 *  for the same reason as reload — Retry already covers an exited thread. */
export function offersRestartWorker(thread: ThreadView, devBuild: boolean): boolean {
  if (!devBuild) return false
  if (thread.kind !== "session" || thread.foreign) return false
  if (thread.backend === "codex" || thread.backend === "acp") return false
  return thread.runtime !== "exited"
}

// `api` is the thread's own project's client (useThreadApi): a queue card of another project must not
// ask the page's project to reload a session it has never heard of.
export async function reloadThreadPlugins(api: Api, thread: ThreadView): Promise<void> {
  try {
    const r = await api.reloadThreadPlugins({ slug: thread.id, sessionId: thread.sessionId ?? "" })
    // Report what CHANGED, not "done": the operator's question is "did my edit land?", and a bare
    // success toast answers it no better than silence.
    const parts = [`${r.plugins} plugin${r.plugins === 1 ? "" : "s"}`, `${r.commands} skill${r.commands === 1 ? "" : "s"}`, `${r.agents} agent${r.agents === 1 ? "" : "s"}`]
    // An MCP change is the one with a real cost — the provider re-reads the whole conversation instead
    // of using its prompt cache — so it is named rather than folded into the counts.
    const mcp = r.mcpServers.length ? ` · MCP: ${r.mcpServers.join(", ")}` : ""
    const errors = r.errorCount ? ` · ${r.errorCount} load error${r.errorCount === 1 ? "" : "s"}` : ""
    showToast(`Reloaded ${parts.join(", ")}${mcp}${errors}`)
  } catch (error) {
    showToast((error instanceof Error ? error.message : "Plugin reload failed").slice(0, 120))
  }
}
