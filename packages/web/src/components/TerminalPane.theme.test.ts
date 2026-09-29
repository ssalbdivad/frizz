import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./TerminalPane.tsx", import.meta.url), "utf8")
// The xterm construction — its theme and the live recolour — moved to lib/xtermSetup.ts when the agent's
// read-only log pane became its second consumer; both panes get exactly this.
const setup = readFileSync(new URL("../lib/xtermSetup.ts", import.meta.url), "utf8")

test("terminal theme includes cursor contrast and every ANSI color", () => {
  assert.match(setup, /cursorAccent: color\("--terminal-cursor-accent"\)/)
  for (const color of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    assert.match(setup, new RegExp(`${color}: color\\("--terminal-${color}"\\)`))
    assert.match(setup, new RegExp(`bright${color[0].toUpperCase()}${color.slice(1)}: color\\("--terminal-bright-${color}"\\)`))
  }
})

test("terminal updates colors only for resolved-theme changes without remounting", () => {
  assert.match(setup, /let resolvedTheme = getThemeSnapshot\(\)\.resolved/)
  assert.match(setup, /if \(nextResolved === resolvedTheme\) return/)
  assert.match(setup, /term\.options\.theme = terminalTheme\(\)/)
  assert.match(source, /mountXterm\(/, "the pty pane builds its xterm through the shared setup")
  // The attach effect keys on WHICH pty (its id, and the project it lives in) and nothing about the
  // theme — a theme change recolours in place rather than tearing the terminal down.
  assert.match(source, /\}, \[id, base\]\)/)
})
