import { createRoot } from "react-dom/client"
import "./styles.css"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { setThemePreference } from "./lib/theme.ts"

// ```ansi fences on the REAL transcript path — mdToHtml, its sanitizer, styles.css, the delegated copy
// button — in both themes (`?theme=light`). Each case is a shape an agent actually sends: the escape
// spelled the way source code spells it, the U+FFFD the Claude runtime substitutes for a raw ESC, and
// the full colour and attribute range. lib/ansiFence.e2e.test.ts reads it back.
const params = new URLSearchParams(location.search)
setThemePreference(params.get("theme") === "light" ? "light" : "dark")

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
const fence = (body: string) => `\`\`\`ansi\n${body}\n\`\`\``

const palette = [
  NAMES.map((name, i) => `\\e[${30 + i}m${name.padEnd(8)}`).join("") + "\\e[0m",
  NAMES.map((name, i) => `\\e[${90 + i}m${name.padEnd(8)}`).join("") + "\\e[0m",
  NAMES.map((name, i) => `\\e[${40 + i}m ${name.padEnd(7)}`).join("") + "\\e[0m",
  NAMES.map((name, i) => `\\e[${100 + i};30m ${name.padEnd(7)}`).join("") + "\\e[0m",
].join("\n")

const cube = Array.from({ length: 36 }, (_, i) => `\\e[48;5;${16 + i * 6}m `).join("") + "\\e[0m"
const greys = Array.from({ length: 24 }, (_, i) => `\\e[48;5;${232 + i}m  `).join("") + "\\e[0m"
const truecolor = Array.from({ length: 48 }, (_, i) => {
  const t = i / 47
  return `\\e[48;2;${Math.round(255 * (1 - t))};${Math.round(128 + 80 * t)};${Math.round(255 * t)}m `
}).join("") + "\\e[0m"

export const CASES: [string, string][] = [
  ["written", fence([
    "\\e[1m\\e[32m✔\\e[0m parses the config \\e[2m(3ms)\\e[0m",
    "\\e[1m\\e[31m✖\\e[0m resolves aliases \\e[2m(12ms)\\e[0m",
    "  \\e[31mAssertionError\\e[0m: expected \\e[32m\"ts\"\\e[0m, got \\e[31m\"plaintext\"\\e[0m",
    "",
    "\\e[1mTests:\\e[0m  \\e[1;31m1 failed\\e[0m, \\e[1;32m41 passed\\e[0m, 42 total",
  ].join("\n"))],
  ["replaced", fence([
    "\ufffd[33mcommit 6c7dcb78\ufffd[m",
    "\ufffd[1mdiff --git a/src/a.ts b/src/a.ts\ufffd[m",
    "\ufffd[36m@@ -1,3 +1,3 @@\ufffd[m",
    "\ufffd[31m-const answer = 41\ufffd[m",
    "\ufffd[32m+const answer = 42\ufffd[m",
  ].join("\n"))],
  ["palette", fence(palette)],
  ["extended", fence([cube, greys, truecolor, "\\e[38;5;208morange 208\\e[0m  \\e[38;2;120;200;255mtruecolor sky\\e[0m"].join("\n"))],
  ["attrs", fence([
    "\\e[1mbold\\e[0m \\e[2mdim\\e[0m \\e[3mitalic\\e[0m \\e[4munderline\\e[0m \\e[9mstrike\\e[0m \\e[7minverse\\e[0m [\\e[8mhidden\\e[0m]",
  ].join("\n"))],
]

installCodeCopyInterceptor()

createRoot(document.getElementById("root")!).render(
  <main className="bg-bg p-6 text-fg">
    <div className="md-body max-w-3xl text-[14px]">
      {CASES.map(([id, md]) => (
        <section key={id} data-case={id} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
      ))}
    </div>
  </main>,
)
