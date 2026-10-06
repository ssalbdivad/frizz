import type { ReactElement } from "react"
import { useQuery } from "@tanstack/react-query"
import type { PluginState, PluginSummary } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { useWebPluginFailures } from "../plugins/loader.tsx"
import { SettingsField } from "./SettingsField.tsx"

// Settings → Frizz plugins: the READ-ONLY audit of the code running inside this Frizz besides its own
// (plans/upstream-superset.md §7, "Security"). A plugin is the operator's own code with the operator's
// privileges and no sandbox, so the guardrail worth having is being able to see, in one place, what each
// one adds — the procedures it answers, the MCP tools and Claude Code plugin it hands every worker — and
// what failed and why. Nothing here changes anything: a plugin is installed by putting its folder in
// `<data>/user-plugins`, turned off with `plugins.disabled` in the machine config, and every one at once
// with FRIZZ_PLUGINS_OFF=1.
//
// "Frizz plugins", never bare "plugins": the word already means Claude Code plugins in this UI (the
// thread menu's "Reload plugins"), and the two are unrelated. Which word the system keeps is Colin's call.

const STATE_LABEL: Record<PluginState, string> = {
  active: "Running",
  failed: "Failed",
  disabled: "Turned off",
  incompatible: "Can't run",
}

const STATE_TONE: Record<PluginState, string> = {
  active: "text-muted-70",
  failed: "text-danger",
  disabled: "text-muted-70",
  incompatible: "text-danger",
}

const HINT = "text-[11px] leading-relaxed text-muted-70"

export function PluginsField(): ReactElement {
  const report = useQuery({ queryKey: ["plugins"], queryFn: () => rpc.plugins(), staleTime: 30_000 })
  const webFailures = useWebPluginFailures()
  const data = report.data
  return (
    <SettingsField label="Frizz plugins" help={SETTINGS_HELP.plugins}>
      {!data ? (
        <p className={HINT}>{report.error ? `Could not read them: ${String(report.error)}` : "Loading…"}</p>
      ) : data.off ? (
        <p className={HINT}>Off for this run: Frizz was started with <code>FRIZZ_PLUGINS_OFF=1</code>.</p>
      ) : data.plugins.length === 0 ? (
        <p className={HINT}>
          None installed. A plugin is a folder in <code className="break-all">{data.root}</code>.
        </p>
      ) : (
        <ul data-plugins-list className="flex flex-col gap-3">
          {data.plugins.map((plugin) => (
            <PluginEntry key={plugin.id} plugin={plugin} webFailure={webFailures.get(plugin.id)} />
          ))}
        </ul>
      )}
    </SettingsField>
  )
}

function PluginEntry({ plugin, webFailure }: { plugin: PluginSummary; webFailure: string | undefined }): ReactElement {
  const failed = plugin.state === "failed" || plugin.state === "incompatible"
  return (
    <li data-plugin={plugin.id} data-plugin-state={plugin.state} className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
        <span className="font-mono-keep truncate text-fg">{plugin.id}</span>
        {plugin.version && <span className="shrink-0 text-[11px] text-muted-70">{plugin.version}</span>}
        <span className={`ml-auto shrink-0 text-[11px] ${STATE_TONE[plugin.state]}`}>{STATE_LABEL[plugin.state]}</span>
      </div>
      {plugin.description && <p className={HINT}>{plugin.description}</p>}
      {plugin.reason && <p className={`break-words text-[11px] leading-relaxed ${failed ? "text-danger" : "text-muted-70"}`}>{plugin.reason}</p>}
      {webFailure && <p className="break-words text-[11px] leading-relaxed text-danger">{webFailure}</p>}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px] leading-relaxed text-muted-70">
        <dt>Procedures</dt>
        <dd className="font-mono-keep break-words">{plugin.procedures.length ? plugin.procedures.map((procedure) => procedure.name).join(", ") : "none"}</dd>
        <dt>MCP tools</dt>
        <dd className="font-mono-keep break-words">{plugin.mcpTools.length ? plugin.mcpTools.join(", ") : "none"}</dd>
        <dt>Claude Code plugin</dt>
        <dd className="font-mono-keep break-all">{plugin.claudeDirs.length ? plugin.claudeDirs.join(", ") : "none"}</dd>
        <dt>Folder</dt>
        <dd className="font-mono-keep break-all">{plugin.dir}</dd>
      </dl>
    </li>
  )
}
