import { createRoot } from "react-dom/client"
import { QuietTurnCard } from "./components/QuietTurnCard.tsx"
import "./styles.css"

// The silent-turn card in each shape it takes: a shell call with its description and command, an MCP
// call with neither, no call open at all, and a codex thread (no interrupt from Frizz).
const since = new Date(Date.now() - 18 * 60_000).toISOString()
const cases = [
  { id: "bash", backend: "claude" as const, quietTurnCall: { name: "Bash", label: "Running the full gate before pushing", command: "pnpm build && pnpm test && pnpm publish --otp" } },
  { id: "mcp", backend: "claude" as const, quietTurnCall: { name: "mcp__chrome-devtools__navigate_page" } },
  { id: "none", backend: "claude" as const, quietTurnCall: undefined },
  { id: "codex", backend: "codex" as const, quietTurnCall: { name: "exec_command", command: "gh auth login" } },
]

createRoot(document.getElementById("root")!).render(
  <div className="mx-auto flex max-w-[1020px] flex-col gap-4 bg-bg p-6">
    {cases.map((c) => (
      <div key={c.id} data-case={c.id}>
        <QuietTurnCard thread={{ quietTurnSince: since, quietTurnCall: c.quietTurnCall, backend: c.backend }} />
      </div>
    ))}
  </div>,
)
