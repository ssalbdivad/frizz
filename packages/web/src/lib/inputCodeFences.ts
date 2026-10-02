import { resolveFenceLanguage, type FenceLanguage } from "./syntaxHighlight.ts"

// Fenced code inside a TEXTAREA — the prompt boxes, the settings fields, every free-text answer. A
// textarea cannot colour part of its own text, so the input surfaces paint a metrics-identical mirror
// of it (components/TextareaCodeFences.tsx, and the Composer's own token backdrop) and this module is
// the part both share: where the fences are, so the mirror knows which runs to hand to highlight.js.
//
// The rules are CommonMark's, cut to what a person typing needs: an opening line of three or more
// backticks or tildes indented at most three spaces, an info string whose first word names the
// grammar (a backtick fence's info string may not itself contain a backtick — "```inline```" on one
// line is inline code, not a fence), and a closing line of the SAME character at least as long. An
// unclosed fence runs to the end of the text, because that is exactly the state of a block being typed.

export type InputFenceRun =
  | { kind: "prose"; start: number; end: number }
  // A delimiter line, info string included. The opening one carries its newline; the closing one
  // leaves its newline to the prose after it.
  | { kind: "fence"; start: number; end: number }
  // The body between the delimiters, newlines included, so its runs tile the text with no gaps.
  | { kind: "code"; start: number; end: number; language: FenceLanguage }

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/

// Every character of `text` lands in exactly one run, in order. Null when no fence opens at all, so a
// caller can skip painting entirely for the overwhelmingly common prose-only box.
export function scanInputFences(text: string): InputFenceRun[] | null {
  if (!text.includes("```") && !text.includes("~~~")) return null
  const runs: InputFenceRun[] = []
  let proseStart = 0
  let open: { char: string; length: number; language: FenceLanguage; bodyStart: number } | null = null
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === open.char && close[1].length >= open.length) {
        if (lineStart > open.bodyStart) runs.push({ kind: "code", start: open.bodyStart, end: lineStart, language: open.language })
        runs.push({ kind: "fence", start: lineStart, end: lineEnd })
        open = null
        proseStart = lineEnd
      }
    } else {
      const match = OPEN.exec(line)
      if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
        if (lineStart > proseStart) runs.push({ kind: "prose", start: proseStart, end: lineStart })
        const bodyStart = newline === -1 ? lineEnd : lineEnd + 1
        runs.push({ kind: "fence", start: lineStart, end: bodyStart })
        open = { char: match[1][0], length: match[1].length, language: resolveFenceLanguage(match[2]), bodyStart }
      }
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  if (open) {
    if (text.length > open.bodyStart) runs.push({ kind: "code", start: open.bodyStart, end: text.length, language: open.language })
  } else if (text.length > proseStart) {
    runs.push({ kind: "prose", start: proseStart, end: text.length })
  }
  return runs.some((run) => run.kind === "fence") ? runs : null
}

// The runs overlapping [start, end), clipped to it — for a mirror that already splits the text on
// something else first (the Composer's staged context tokens) and must fence-split each piece.
export function clipFenceRuns(runs: readonly InputFenceRun[], start: number, end: number): InputFenceRun[] {
  const out: InputFenceRun[] = []
  for (const run of runs) {
    if (run.end <= start || run.start >= end) continue
    out.push({ ...run, start: Math.max(run.start, start), end: Math.min(run.end, end) })
  }
  return out
}
