# PreToolUse(Bash) PRE-FILTER for bash-background.mjs. Not a hook of its own: hooks.json runs it as
# `sh .../bash-background.sh || node .../bash-background.mjs`, and it either answers `{}` itself or
# hands the identical stdin to that node hook.
#
# WHY: the node hook fires on every Bash call a worker makes, and almost every call is one it answers
# with `{}`. Starting node was the whole cost — p50 67ms, p95 346ms, max 4.9s per call, 62 minutes over
# 36k calls in three days of worker transcripts (2026-09-29..10-01), with `node trivial.mjs` within noise
# of the real hook. This file answers `{}` only where it can PROVE node would, and in pure POSIX sh with
# no subprocess, so a skipped call costs one `sh` start instead of a node start. Over 127k distinct real
# Bash inputs it answers 93% itself; replayed through `/bin/sh -c` on this repo's WSL box (loadavg ~6),
# the hook went from p50 85-88ms to 4.4ms, and the time over 1,000 calls from 90s to 11s (2026-10-02;
# the conditions are in the commit). A call handed to node pays ~3ms more than before.
#
# THE PROOF — read it against bash-background.mjs and worktree.mjs before changing either. Node emits
# something other than `{}` only through one of these, and each is ruled out by a check below:
#   1. hasEscapingBackgroundJob → DENY. Needs an `&` in tool_input.command that is a background
#      operator. Node discards an `&` whose neighbour (after blanking quotes and heredoc bodies) is `&`
#      before or after, `>`/`<` before, or `>` after. Those neighbours are never quote characters, so
#      blanking never separates them from an `&` that survives it, and `bash -c "…"` un-escaping only ever
#      removes a backslash, never one of them. So an `&` whose RAW neighbour is one of them can never be
#      an operator at any recursion depth. A backslash neighbour is deliberately NOT accepted: node's own
#      `\&` exemption is undone by that un-escaping (`bash -c "job \&"` is denied).
#   2. evaluateWorktreeGuard → DENY. Needs `\bworktree\b` in the command (worktreeAddTargets' first
#      test). A raw `worktree` followed by a raw word character [A-Za-z0-9_] is followed by that same
#      character once decoded (an escape starts with `\`, which is not one), so it fails `\b` and is
#      not that word. Every other `worktree` — `worktree add`, `worktree\tadd`, `worktree"` — goes to
#      node. The word set is spelled out, never a range: `[A-Z]` matches lowercase in some locales.
#      This is what lets `cd …/.frizz/worktrees/<slug> && …`, a worker's every other call, skip.
#   3. untimed run_in_background → advice. Needs `run_in_background` set to `true`.
#   4. long foreground → advice. Needs a `timeout` number above LONG_FOREGROUND_MS (15m = 900000).
#   5. FRIZZ_THREAD empty → node answers `{}` for every input, so this does too.
# Everything else in node only narrows those (sub-agent, codex `model`, a declared timeout) and never
# turns a `{}` into output, so this file ignores it: such calls just run node.
#
# THE JSON IS NEVER PARSED, ONLY SCANNED, so every check is conservative on the raw text:
#   - Malformed JSON is node's `{}` (its catch), so only valid JSON needs reasoning about.
#   - Any `\u` escape anywhere → node. That is the one JSON escape that could spell `&`, `worktree`, or a
#     key name without its letters appearing literally. A `\u` is an escape when the backslashes before
#     its `u` are odd in number; the check sends a `\u` after a non-backslash (one) or after `\\\` (three
#     or more, odd or not) to node, so what stays is exactly `X\\u`: an escaped backslash, then a plain
#     `u` — `printf '\\u2014'`, or a Windows path `C:\\Users\\u…` in `cwd` that would otherwise send
#     every call to node.
#   - `"tool_input"` must appear exactly once, and checks 1-4 read only the text after it (and its `:`).
#     With no `\u` escape, a real top-level `tool_input` key is spelled literally, so if it exists it is
#     that one occurrence, and its whole value lies after it. If it does not exist, node reads no
#     command and answers `{}`, so skipping is right whatever the text says. The count is of the bare
#     quoted name, NOT of `"tool_input":` — a key like `"a\"tool_input"` holds that spelling, and with
#     the real key written `"tool_input" :` the first `"tool_input":` was the impostor, after the real
#     value: a draft that counted the colon form skipped a call node denies.
#     The prefix is skipped because it holds `cwd` and `transcript_path`.
#   - `"run_in_background"` may appear there at most once, followed by exactly `:false` and `,` or `}`;
#     `"timeout"` at most once, followed by a plain integer of at most 900000 and `,` or `}`. Any other
#     spelling (whitespace, a float, an exponent, a string, a duplicate key, whose last copy is the one
#     JSON.parse keeps) → node.
#   - Inputs over 64KB → node.
#
# EVERY CHECK IS A `case` PATTERN, never a loop or a `${var#*pattern}` cut. Cutting is quadratic in
# every shell measured: `${x#*'"tool_input":'}` with the marker 60KB in took 4.7s in dash and 12s in
# bash, and an earlier per-`&` loop took 21s on a 9.6KB command holding 2,400 of them. A `case` match
# stays bounded: 64KB inputs built to make it backtrack (runs of `a && `, `2>&1 `, `worktree_`) are
# decided in 21-80ms under dash, bash and busybox, a real-shaped 62KB one in 27-50ms.
# What stays slow is `read`: a byte per syscall on a pipe, and it runs BEFORE the 64KB cap is checked.
# That costs ~0.4ms per KB under dash here and ~4ms per KB under Git Bash on this box's Windows side
# (node.exe spawning sh.exe, loadavg ~10, 2026-10-02; a review at loadavg 30-40 saw ~13ms per KB). So
# the corpus p99 (6.5KB) reads in ~2ms / ~25ms, and the largest real input (90KB, over the cap, so it
# goes to node anyway) in ~40ms / 0.4-1.2s. 127 of 127,064 real inputs exceed 20KB. Accepted: POSIX
# `read` cannot stop inside a line, and a `head -c` fork to bound it would charge every call for the rare one.
# packages/server/src/bash-background-prefilter.test.ts checks every one of these against node on real
# transcript inputs and on adversarial ones; scripts/bash-prefilter-corpus.ts re-derives its fixture.
#
# FAIL OPEN. Claude Code reads exit status 2 from a PreToolUse hook as "block this call", and sh exits 2
# on a syntax error. So the first thing this file does is arm an EXIT trap that runs node instead: a
# syntax or fatal runtime error anywhere below lands in node, which answers exactly as it did before this
# file existed. Every deliberate exit disarms the trap first.
# What the trap cannot catch is this file never running: dash exits 2 on a script it cannot OPEN, and a
# CRLF checkout breaks the trap line itself (`EXIT\r` is no signal) before the next line's syntax error
# exits 2. Hence `||` in hooks.json rather than the first draft's `exec sh …; node …`, which blocked EVERY
# Bash call in both cases: any failure exit here — a missing file, a missing `sh` (127), CRLF — reaches
# node with the stdin still unread. Once this file runs, it exits 0 even when the node it handed off to
# fails (see the trap): a non-zero exit there would start the `||` node too, on drained stdin.
# (.gitattributes pins this file to LF so the CRLF case stays a slow path, not the Windows default.)
#
# WINDOWS, as read out of Claude Code 2.1.287's binary (2026-10-02): a shell-form hook runs as
# `spawn(command, [], { shell: <Git>\bin\bash.exe })`, i.e. `bash.exe -c <command>`, with the folder of
# that bash.exe put first on PATH and CLAUDE_PLUGIN_ROOT spelled with forward slashes, so `sh` is Git's
# own `sh.exe` and this file runs as it does anywhere else. Replayed that way with the host's real Git
# Bash and node.exe (this WSL machine's Windows side, plugin root under a path with a space): 1,008 inputs
# answered byte-for-byte as node alone answers them, 28 of them node's denials and advice; with this file
# deleted, 48 of 48 still did. Only when Claude finds no Git Bash does it run hooks under PowerShell, and
# then it registers no Bash tool at all ("Git Bash not found; BashTool will be unavailable"), so this
# matcher never fires there. If it ever did: pwsh 7 reads `||` as its own chain operator and falls through
# to node (48 of 48 identical), while Windows PowerShell 5.1 cannot parse `||` and the hook fails exit 1
# — non-blocking, but with the guard off.
#
# POSIX sh only — dash, bash 5, bash --posix and busybox ash take identical decisions on every input the
# test feeds them (it runs whichever of them a box has), as does Git Bash on the Windows replay above:
# no arrays, no `${var//}`, no `[[`, no subprocess. macOS's /bin/sh (bash 3.2) was never run.

# Once node has answered (or failed to), end with status 0 either way. Node itself only ever exits 0
# (`emit`), so a non-zero status is a crash, a signal or a missing node, and every one of those allowed
# the call before this file existed too (only 2 blocks). Passing it on would trip hooks.json's `||`,
# which would start a SECOND node on the stdin this file already drained, and that one answers `{}`,
# exit 0: the failure silently swallowed at the cost of another node start. So it goes to stderr. Spelled
# out here and at the end rather than as a function, so the trap depends on nothing defined after it.
trap 'trap - EXIT; if [ -n "${prefilter_read:-}" ]; then printf %s "$prefilter_input" | node "$prefilter_dir/bash-background.mjs" "$@"; else node "$prefilter_dir/bash-background.mjs" "$@"; fi; prefilter_status=$?; [ $prefilter_status -eq 0 ] || printf "bash-background.sh: node exited %s; the call is allowed\n" $prefilter_status >&2; exit 0' EXIT

case $0 in
  */*) prefilter_dir=${0%/*} ;;
  *) prefilter_dir=. ;;
esac

# Read stdin whole, byte for byte (Claude sends one JSON line and a newline; `read` keeps everything but
# NUL, which JSON text cannot contain). A builtin loop rather than `$(cat)`: no fork.
prefilter_nl='
'
prefilter_input=
while IFS= read -r prefilter_line; do
  prefilter_input=$prefilter_input$prefilter_line$prefilter_nl
done
prefilter_input=$prefilter_input$prefilter_line
prefilter_read=1

# Exit 0 only when node would answer `{}`; see the proof above. Every check is one `case` over the
# whole input, scoped to the text after the `"tool_input":` marker by a leading `*'"tool_input":'*`.
prefilter_skippable() {
  [ $# -eq 0 ] || return 1
  [ -n "${FRIZZ_THREAD:-}" ] || return 0
  [ ${#prefilter_input} -le 65536 ] || return 1
  case $prefilter_input in
    *[!\\]'\u'* | *'\\\u'*) return 1 ;;
    *'"tool_input"'*'"tool_input"'*) return 1 ;;
    *'"tool_input":'*) ;;
    *) return 1 ;;
  esac
  case $prefilter_input in
    *'"tool_input":'*worktree[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*) return 1 ;;
    # An `&` with no neighbour node discards it for: not `&`/`>`/`<` before, not `&`/`>` after.
    *'"tool_input":'*[!\&\>\<]\&[!\&\>]* | *'"tool_input":'*[!\&\>\<]\& | *'"tool_input":&'*) return 1 ;;
  esac
  case $prefilter_input in
    *'"tool_input":'*'"run_in_background"'*'"run_in_background"'*) return 1 ;;
    *'"tool_input":'*'"run_in_background":false,'* | *'"tool_input":'*'"run_in_background":false}'*) ;;
    *'"tool_input":'*'"run_in_background"'*) return 1 ;;
  esac
  case $prefilter_input in
    *'"tool_input":'*'"timeout"'*'"timeout"'*) return 1 ;;
    *'"tool_input":'*'"timeout":'[0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-8][0-9][0-9][0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":900000'[,\}]*) ;;
    *'"tool_input":'*'"timeout"'*) return 1 ;;
  esac
  return 0
}

if prefilter_skippable "$@"; then
  trap - EXIT
  printf '{}'
  exit 0
fi
trap - EXIT
printf %s "$prefilter_input" | node "$prefilter_dir/bash-background.mjs" "$@"
prefilter_status=$?
[ $prefilter_status -eq 0 ] || printf 'bash-background.sh: node exited %s; the call is allowed\n' $prefilter_status >&2
exit 0
