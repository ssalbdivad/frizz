import { Terminal, type ITerminalOptions } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { getThemeSnapshot, subscribeTheme } from "./theme.ts"

// ONE XTERM, BUILT ONE WAY — for both panes that draw a terminal: your pty (TerminalPane, over the /term
// socket) and an agent's log (ShellLogPane, read-only, fed by polling the harness's task file). Extracted
// from TerminalPane on 2026-09-29 when the second consumer arrived; everything here is what the two share
// and nothing else — no socket, no input. Browser-only (@xterm/xterm touches the DOM at import), so every
// consumer loads it through a lazy component.

export function terminalTheme() {
  const root = getComputedStyle(document.documentElement)
  const color = (name: string) => root.getPropertyValue(name).trim()
  return {
    background: color("--color-bg"), foreground: color("--color-fg"), cursor: color("--terminal-cursor"), cursorAccent: color("--terminal-cursor-accent") || color("--color-bg"), selectionBackground: color("--terminal-selection"),
    black: color("--terminal-black"), red: color("--terminal-red"), green: color("--terminal-green"), yellow: color("--terminal-yellow"), blue: color("--terminal-blue"), magenta: color("--terminal-magenta"), cyan: color("--terminal-cyan"), white: color("--terminal-white"),
    brightBlack: color("--terminal-bright-black"), brightRed: color("--terminal-bright-red"), brightGreen: color("--terminal-bright-green"), brightYellow: color("--terminal-bright-yellow"), brightBlue: color("--terminal-bright-blue"), brightMagenta: color("--terminal-bright-magenta"), brightCyan: color("--terminal-bright-cyan"), brightWhite: color("--terminal-bright-white"),
  }
}

export interface MountedXterm {
  term: Terminal
  /** Tear down: the resize observer and theme subscription now, the terminal itself one task later. */
  dispose: () => void
}

/**
 * Open an xterm in `host`, fitted to it, recoloured in place when the theme flips, refitted when the host
 * resizes. `onGridResize` hears a REAL change of cols/rows only — see the observer below.
 *
 * RENDERER: the built-in DOM renderer, NOT @xterm/addon-webgl — see TerminalPane for the dpr desync that
 * packed every row into the bottom-left quarter of the canvas.
 */
export function mountXterm(host: HTMLElement, options: ITerminalOptions = {}, onGridResize?: (cols: number, rows: number) => void): MountedXterm {
  const term = new Terminal({
    fontFamily: "Menlo, ui-monospace, monospace",
    fontSize: 13,
    theme: terminalTheme(),
    scrollback: 10000,
    allowProposedApi: true,
    cursorBlink: true,
    ...options,
  })
  let resolvedTheme = getThemeSnapshot().resolved
  const unsubscribeTheme = subscribeTheme(() => {
    const nextResolved = getThemeSnapshot().resolved
    if (nextResolved === resolvedTheme) return
    resolvedTheme = nextResolved
    term.options.theme = terminalTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)
  // NEVER fit against a degenerate host (a mid-layout zero-height mount produced NaN grid state that
  // corrupted xterm internals and crashed dispose, unmounting the whole workpane).
  const initialDims = fit.proposeDimensions()
  if (initialDims && Number.isFinite(initialDims.cols) && Number.isFinite(initialDims.rows) && initialDims.rows > 1) {
    fit.fit()
  }

  // Resize ONLY when the grid actually changes. The naive version (fit + send on every ResizeObserver
  // tick) fed a repaint storm: each ~1s board push re-rendered the layout, the observer fired on no-op
  // layout passes, every fit() forced an xterm reflow, and every resize message forced the pty to reflow
  // and repaint the whole screen ("random line-shifting repaints"). So: debounce a beat, compute the
  // PROPOSED grid, and touch xterm (and the caller) only on a real cols/rows change.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      const dims = fit.proposeDimensions()
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.rows <= 1) return
      if (dims.cols === term.cols && dims.rows === term.rows) return
      fit.fit()
      onGridResize?.(term.cols, term.rows)
    }, 120)
  })
  ro.observe(host)

  return {
    term,
    dispose: () => {
      clearTimeout(resizeTimer)
      ro.disconnect()
      unsubscribeTheme()
      // dispose() can throw if xterm internals were corrupted (e.g. a zero-dim fit) — a cleanup throw
      // would take the whole React tree down with it, which is far worse than a leak.
      //
      // DEFERRED ONE TASK. `term.open()` queues a `setTimeout(() => viewport.syncScrollArea())` (xterm 5.5
      // Viewport's constructor), and a pane torn down before it fires — a queue card mounted and dropped in
      // the same beat — disposed the renderer underneath it: an uncaught "reading 'dimensions'". Timers of
      // one delay run in the order they were set, so this one lands after xterm's, against a live term.
      setTimeout(() => {
        try {
          term.dispose()
        } catch (e) {
          console.warn("xterm dispose failed", e)
        }
      })
    },
  }
}
