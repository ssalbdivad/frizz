import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./ExternalTerminalCommand.tsx", import.meta.url)), "utf8")

test("copy command button acknowledges only on real success and renders both icon states", () => {
  // The check is driven from a completed clipboard write, NEVER shown optimistically before it lands —
  // otherwise the user pastes into the race before the command is on the clipboard. WARM path: begin()
  // lives inside the writeText success branch. COLD fallback: begin() rides the async mutation's onSuccess.
  assert.match(source, /copyTextToClipboard\(resolved\.command\)\.then\(\s*\(\) => \{\s*feedback\.current\?\.begin\(\)/)
  assert.match(source, /copyAsync\(\{ onSuccess: \(\) => feedback\.current\?\.begin\(\) \}\)/)
  assert.match(source, /copied\s*\? <Check[\s\S]*: <TerminalSquare/)
  assert.match(source, /useEffect\(\(\) => \(\) => feedback\.current\?\.dispose\(\), \[\]\)/)
})

// ATTACH and RESUME are genuinely different commands — one joins the live pane (and so can show an
// in-flight turn or a permission prompt), the other starts a separate process off the transcript and
// can show neither. Naming both "resume" sent people to the wrong terminal, so every user-visible
// string is keyed off the resolved mode and none of them hardcodes "resume".
test("the label and toast name the actual mode, never a blanket 'resume'", () => {
  assert.match(source, /const COPIED_TOAST: Record<TerminalMode, string> = \{\s*attach: "Attach command copied",\s*resume: "Resume command copied",/)
  assert.match(source, /attach: "Copy command to attach to this thread's live terminal"/)
  assert.match(source, /resume: "Copy command to resume this thread in a new terminal"/)
  // Before the prefetch resolves there is no truthful mode to promise, so the label stays generic
  // rather than guessing — guessing is what produced the original wrong-command bug.
  assert.match(source, /: \(prefetched \? BUTTON_LABEL\[prefetched\.mode\] : "Copy terminal command"\)/)
  assert.match(source, /showToast\(COPIED_TOAST\[resolved\.mode\]\)/)
  assert.match(source, /showToast\(COPIED_TOAST\[mode\]\)/)
})

test("the click writes a PREFETCHED command synchronously (no RPC inside the clipboard gesture)", () => {
  // The command is warmed into the query cache on hover/focus, so the click reads it synchronously and
  // writes without a round-trip in the activation window — the fix for the dead-in-a-queue-card copy and
  // the laggy check. Cold cache falls through to the activation-safe async path.
  assert.match(source, /onPointerEnter=\{prefetch\}/)
  assert.match(source, /onFocus=\{prefetch\}/)
  assert.match(source, /queryClient\.prefetchQuery\(\{\s*queryKey: commandKey/)
  assert.match(source, /const resolved = queryClient\.getQueryData<ResolvedTerminalCommand>\(commandKey\)/)
  assert.match(source, /if \(resolved\) \{/)
})

test("no path refuses the copy on an insecure origin", () => {
  // `navigator.clipboard` is undefined on plain http off localhost — the LAN `--host` case, where a
  // phone reads the board. Every write goes through copyTextToClipboard, whose execCommand fallback
  // still lands the copy there; the old "copy the command from a secure Frizz page" refusal is gone.
  assert.match(source, /import \{ copyTextToClipboard \} from "\.\.\/lib\/clipboard\.ts"/)
  assert.doesNotMatch(source, /secure Frizz page/)
  assert.doesNotMatch(source, /navigator\.clipboard\.writeText/)
})

test("the confirmation check is the app foreground (white), not the live green", () => {
  assert.match(source, /<Check size=\{14\} strokeWidth=\{2\.2\} className="text-fg" \/>/)
  assert.doesNotMatch(source, /text-live/)
})

test("copy survives the async RPC by writing through the activation-safe ClipboardItem promise", () => {
  // A plain writeText AFTER awaiting the RPC loses the click's user activation; the ClipboardItem
  // promise form keeps it alive. writeText remains only as the fallback for engines without it.
  assert.match(source, /navigator\.clipboard\.write\(\[\s*new ClipboardItem\(\{ "text\/plain": resolved\.then/)
})
