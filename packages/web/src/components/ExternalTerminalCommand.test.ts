import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./ExternalTerminalCommand.tsx", import.meta.url)), "utf8")

// ATTACH and RESUME are genuinely different commands — one joins the live pane (and so can show an
// in-flight turn or a permission prompt), the other starts a separate process off the transcript and
// can show neither. Naming both "resume" sent people to the wrong terminal, so every user-visible
// string is keyed off the resolved mode and none of them hardcodes "resume".
test("the label and toast name the actual mode, never a blanket 'resume'", () => {
  assert.match(source, /const COPIED_TOAST: Record<TerminalMode, string> = \{\s*attach: "Attach command copied",\s*resume: "Resume command copied",/)
  assert.match(source, /attach: "Copy attach command"/)
  assert.match(source, /resume: "Copy resume command"/)
  // Before the prefetch resolves there is no truthful mode to promise, so the label stays generic
  // rather than guessing — guessing is what produced the original wrong-command bug.
  assert.match(source, /label: prefetched \? MENU_LABEL\[prefetched\.mode\] : "Copy terminal command"/)
  assert.match(source, /showToast\(COPIED_TOAST\[resolved\.mode\]\)/)
  assert.match(source, /showToast\(COPIED_TOAST\[mode\]\)/)
})

test("the pick writes a PREFETCHED command synchronously (no RPC inside the clipboard gesture)", () => {
  // The command is warmed into the query cache when the thread menu opens, so the pick reads it
  // synchronously and writes without a round-trip in the activation window. Cold cache falls through to
  // the activation-safe async path.
  const menu = readFileSync(fileURLToPath(new URL("./ThreadMenu.tsx", import.meta.url)), "utf8")
  // The menu's open state is controlled (its `m` key opens it from the trigger), so the prefetch lives
  // in the one named handler both the click and the key go through. That handler also does other work —
  // since 2026-10-01 (124aa000) closing it drops the "Open in editor" folder choice — so pin the two
  // statements that matter inside its body rather than the body's exact shape.
  // The body ends at the first `}` indented to the handler's own level; `\r?` keeps a CRLF checkout working.
  const handler = menu.match(/const onOpenChange = \(next: boolean\) => \{\r?\n([\s\S]*?)\r?\n  \}\r?\n/)?.[1]
  assert.ok(handler, "ThreadMenu's onOpenChange handler should remain discoverable")
  assert.match(handler, /^\s*setOpen\(next\)$/m)
  assert.match(handler, /^\s*if \(next && ownSession\) terminalCommand\.prefetch\(\)$/m)
  assert.match(menu, /<Menu open=\{open\} onOpenChange=\{onOpenChange\}>/)
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

test("copy survives the async RPC by writing through the activation-safe ClipboardItem promise", () => {
  // A plain writeText AFTER awaiting the RPC loses the click's user activation; the ClipboardItem
  // promise form keeps it alive. writeText remains only as the fallback for engines without it.
  assert.match(source, /navigator\.clipboard\.write\(\[\s*new ClipboardItem\(\{ "text\/plain": resolved\.then/)
})
