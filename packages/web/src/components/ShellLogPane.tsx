import { useEffect, useRef } from "react"
import { mountXterm } from "../lib/xtermSetup.ts"
import { shellLogHead, type ShellLogStream } from "../lib/shellLog.ts"

// AN AGENT TERMINAL'S OUTPUT, IN A TERMINAL — the read-only half of the one terminal drawer (TerminalSheet).
// The same xterm your own terminal gets (lib/xtermSetup.ts), so colour, `\r` progress bars and wide output
// render the way they would have on the agent's screen; but nothing here is a pty. The bytes are the log
// file the harness writes for the shell, streamed by offset (hooks.ts useShellLog), and the terminal takes
// no input: `disableStdin`, no cursor, no socket, no resize sent anywhere.
//
// LAZY, like every xterm consumer: @xterm/xterm is browser-only, and node (tests) imports the drawer stack.
export function ShellLogPane({ stream }: { stream: ShellLogStream }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // `convertEol`: a log file's lines end in a bare `\n`, which a terminal reads as "down one row" and
    // not "back to column 0" — without it every line would start where the last one ended.
    const { term, dispose } = mountXterm(host, { disableStdin: true, convertEol: true, cursorBlink: false })
    // Nothing reads keystrokes here, so a cursor block would only claim otherwise (DECTCEM hide).
    const HIDE_CURSOR = "\x1b[?25l"
    term.write(HIDE_CURSOR)
    // ESCAPE CLOSES THIS DRAWER, even with focus in the xterm. xterm handles every keydown on its own
    // textarea and CANCELS it (stopPropagation) once it has turned it into bytes — `disableStdin` only
    // drops the bytes afterwards — so the drawer stack's window listener never heard it (measured on the
    // live stack: focus in the pane, Escape, drawer still open). Returning false from the custom handler
    // is xterm's own "not mine": it returns before the cancel and the event bubbles on.
    term.attachCustomKeyEventHandler((event) => event.key !== "Escape")
    const detach = stream.attach((event) => {
      if (event.kind === "reset") {
        term.reset()
        term.write(HIDE_CURSOR + shellLogHead(event))
      } else {
        term.write(event.text)
      }
    })
    return () => {
      detach()
      dispose()
    }
  }, [stream])
  return (
    // `data-shell-log-pane` lets the drawer stack's Escape close this drawer even from inside the xterm:
    // unlike your own terminal, there is no program here that Escape could mean anything to.
    <div data-shell-log-pane className="relative min-h-0 flex-1 bg-bg">
      <div ref={hostRef} className="absolute inset-0 p-2" />
    </div>
  )
}
