import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Composer } from "./components/Composer.tsx"
import { TextareaCodeFences } from "./components/TextareaCodeFences.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Browser QA for code-fence highlighting in input boxes: the real <Composer> (its own token backdrop
// paints the fences) and plain textareas carrying <TextareaCodeFences>, one of them scrolled past its
// height so a classic scrollbar narrows its text box. `?ghost` paints the textarea's own glyphs red
// beneath the mirror: any red fringe in the shot is a mirror glyph off its textarea glyph.
window.fetch = async () => new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })

const SAMPLE = [
  "Can you check this @nobody handler? It is wrapping oddly at narrow widths:",
  "```ts",
  "// fetch the user, then render their profile card",
  "export async function load(id: string): Promise<User | null> {",
  "  const res = await fetch(`/api/users/${id}`, { method: \"GET\" })",
  "  return res.ok ? ((await res.json()) as User) : null",
  "}",
  "```",
  "and the shell side:",
  "~~~bash",
  "for f in src/*.ts; do echo \"$f\"; done # every file",
  "~~~",
  "",
].join("\n")

function Fixture() {
  const [composer, setComposer] = useState(SAMPLE)
  const [plain, setPlain] = useState(SAMPLE)
  const [mono, setMono] = useState(SAMPLE + "```python\ndef f(x):\n    return x ** 2  # square\n")
  return (
    <div className="min-h-screen bg-bg text-fg flex flex-col items-center gap-8 p-8">
      <div className="w-[560px]">
        <p className="mb-2 text-[11px] text-muted">Composer</p>
        <Composer surface="newComposer" value={composer} onChange={setComposer} onSubmit={() => {}} minHeight={96} maxHeight={400} />
      </div>
      <div className="w-[560px] flex flex-col gap-1.5">
        <p className="text-[11px] text-muted">Plain textarea (Spinoff styling)</p>
        <textarea data-fixture="plain" value={plain} onChange={(e) => setPlain(e.target.value)} rows={14} className="w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-[13px] leading-5 text-fg outline-none focus:border-accent" />
        <TextareaCodeFences value={plain} />
      </div>
      <div className="w-[420px] flex flex-col">
        <p className="text-[11px] text-muted">Mono settings field, scrolled</p>
        <textarea data-fixture="mono" value={mono} onChange={(e) => setMono(e.target.value)} rows={6} className="input mt-1 resize-y text-[12px] leading-relaxed font-mono-keep" />
        <TextareaCodeFences value={mono} />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)

if (location.search.includes("ghost")) {
  const style = document.createElement("style")
  style.textContent = "textarea { -webkit-text-fill-color: red !important; }"
  document.head.append(style)
}
