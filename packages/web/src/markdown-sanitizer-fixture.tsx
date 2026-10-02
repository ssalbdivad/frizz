import { createRoot } from "react-dom/client"
import "./styles.css"
import { mdToHtml } from "./lib/markdown.ts"

// The sanitizer in lib/markdown.ts only exists in a DOM, so this is where it gets tested. Two halves:
// SHAPE cases pin what agent-written markdown must still communicate after sanitizing (task-list
// state, a list's own numbering, table alignment, prose that merely LOOKS like a tag), and XSS cases
// are an escape battery against the widened rule that unwraps a disallowed tag instead of deleting it.
export const SHAPE: [string, string][] = [
  ["tasklist", "- [x] Reproduce the failing fixture\n- [ ] Bisect to the offending commit"],
  ["tasklist-custom", "- [/] Implement the fix\n- [-] Drop the rejected approach\n- [?] Confirm the human-owned decision"],
  ["tasklist-loose", "- [x] First item\n\n- [ ] Second item"],
  ["tasklist-nested", "- [-] Drop the rejected approach\n  - [ ] still live"],
  // GFM wants a space after the bracket, so a bare marker is the shape server/dispatch.ts writes into
  // every new scratchpad's Task list and the one most likely to regress back to literal text.
  ["tasklist-empty", "- [ ]\n- [x]"],
  ["olstart", "17. `install.sandbox` — the baseline policy\n18. `run.sandbox` — the default"],
  ["align", "| left | mid | right |\n| :--- | :---: | ---: |\n| a | b | c |"],
  ["generic", "The handler returns Promise<void> and then logs the slug."],
  ["placeholder", "Write to <cwdSlug>/<sessionId>.jsonl and restart the tailer."],
  ["details", "<details><summary>Full trace</summary>\n\nThe stack was 40 frames deep.\n\n</details>"],
]

export const XSS: [string, string][] = [
  ["x-script", "<script>window.__pwned='script'</script>after"],
  ["x-img", '<img src=x onerror="window.__pwned=\'img\'">after'],
  ["x-jsurl", '<a href="javascript:window.__pwned=\'href\'">click</a>'],
  ["x-unknown-handler", '<unknown onclick="window.__pwned=\'unknown\'">visible text</unknown>'],
  ["x-style", "<style>body{display:none}</style>after"],
  ["x-div-script", "<div><script>window.__pwned='nested'</script>kept</div>"],
  ["x-svg", "<svg><script>window.__pwned='svg'</script></svg>after"],
  ["x-noscript", "<noscript><img src=x onerror=\"window.__pwned='ns'\"></noscript>after"],
  ["x-template", "<template><img src=x onerror=\"window.__pwned='tpl'\"></template>after"],
  ["x-iframe", '<iframe src="javascript:window.__pwned=\'iframe\'"></iframe>after'],
  ["x-deep", '<foo><bar onclick="window.__pwned=\'deep\'">deep text</bar></foo>'],
  ["x-olstart", '<ol start="javascript:1"><li>a</li></ol>'],
  ["x-tdalign", '<table><tr><td align="x" onclick="window.__pwned=\'td\'">cell</td></tr></table>'],
  ["x-form", '<form action="/x"><input name="pw" type="password"></form>after'],
  // A span may carry an inline style — an ```ansi fence's hex colour — but ONLY that exact shape.
  ["x-span-style", '<span style="background:url(javascript:window.__pwned=\'css\')">styled</span> <span style="color:#ff0000;position:fixed;inset:0">fixed</span> <p style="color:#ff0000">para</p>'],
]

createRoot(document.getElementById("root")!).render(
  <main className="p-6">
    <div className="md-body max-w-2xl">
      {[...SHAPE, ...XSS].map(([id, md]) => (
        <section key={id} data-case={id} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
      ))}
    </div>
  </main>,
)
